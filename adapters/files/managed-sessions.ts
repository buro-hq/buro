import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import type { ManagedSession, ManagedSessionStore } from '../../core/model-ports.ts';

const call = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
const result = z.object({
  content: z.string(),
  isError: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
});
const schema = z.object({
  version: z.literal(1),
  id: z.string(),
  runtimeId: z.string(),
  limits: z.object({
    contextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxRequestsPerTurn: z.number().int().positive(),
    maxToolCallsPerTurn: z.number().int().positive(),
    maxSessionRequests: z.number().int().positive(),
  }),
  providerId: z.string(),
  providerRevision: z.string(),
  requestedModel: z.string(),
  reportedModel: z.string().optional(),
  scope: z.object({
    projectId: z.string(),
    runId: z.string().optional(),
    sessionId: z.string(),
    workspace: z.string(),
    readOnly: z.boolean(),
    allowedPaths: z.array(z.string()),
    protectedPaths: z.array(z.string()),
    materials: z.array(z.string()),
    commands: z.array(z.object({ id: z.string(), command: z.string(), timeoutMs: z.number() })),
    baseCommit: z.string().optional(),
  }),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
      toolCalls: z.array(call).optional(),
      toolCallId: z.string().optional(),
      toolName: z.string().optional(),
      continuation: z.unknown().optional(),
    }),
  ),
  status: z.enum(['ready', 'running', 'interrupted', 'failed']),
  cancelRequested: z.boolean().optional(),
  requests: z.number().int().nonnegative(),
  usage: z.object({
    requestsWithUsage: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }),
  actions: z.array(
    z.object({
      id: z.string(),
      turnId: z.string(),
      call,
      status: z.enum(['pending', 'completed', 'unknown']),
      result: result.optional(),
    }),
  ),
});

/** Private checkpoints live separately from public project state and exported events. */
export class FileManagedSessions implements ManagedSessionStore {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }
  private filename(id: string) {
    if (!/^M-[A-Za-z0-9_-]{1,160}$/.test(id))
      throw new DomainError('INVALID_SESSION_ID', 'Invalid managed session ID.');
    return path.join(this.directory, id + '.json');
  }
  private async prepare() {
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new DomainError('UNSAFE_CHECKPOINT', 'Checkpoint storage cannot contain symlinks.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(this.directory)) !== this.directory)
      throw new DomainError('UNSAFE_CHECKPOINT', 'Checkpoint storage cannot contain symlinks.');
    await fs.chmod(this.directory, 0o700);
  }
  async load(id: string) {
    const filename = this.filename(id);
    await this.queue;
    await this.prepare();
    try {
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new DomainError('UNSAFE_CHECKPOINT', 'A checkpoint cannot be a symlink.');
      const session = schema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      if (session.id !== id)
        throw new DomainError('INVALID_CHECKPOINT', 'Checkpoint identity mismatch.');
      return session as ManagedSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(session: ManagedSession) {
    const filename = this.filename(session.id);
    const bytes = JSON.stringify(schema.parse(structuredClone(session)));
    const work = this.queue.then(async () => {
      await this.prepare();
      const temp = filename + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, filename);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
