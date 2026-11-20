import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../core/ports.ts';
import type { ManagedSession, ManagedSessionStore } from '../../core/model-ports.ts';
import {
  parseSegmentClosing,
  segmentActionReceipts,
  segmentMessages,
  validateSegmentEvidence,
  validateSegmentLimits,
} from '../../core/work-segments.ts';

const call = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
const result = z.object({
  content: z.string(),
  isError: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
});
const scope = z.object({
  projectId: z.string(),
  runId: z.string().optional(),
  ownerRunId: z.string().optional(),
  sessionId: z.string(),
  workspace: z.string(),
  readOnly: z.boolean(),
  allowedPaths: z.array(z.string()),
  protectedPaths: z.array(z.string()),
  materials: z.array(z.string()),
  commands: z.array(z.object({ id: z.string(), command: z.string(), timeoutMs: z.number() })),
  baseCommit: z.string().optional(),
});
const message = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(call).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  continuation: z.unknown().optional(),
});
const anchor = z.strictObject({
  turnId: z.string().min(1),
  instructions: z.string(),
  task: z.string(),
  scopeRevision: z.number().int().positive(),
});
const evidence = z.strictObject({
  version: z.literal(1),
  baseCommit: z.string(),
  headCommit: z.string(),
  workspaceFingerprint: z.string(),
  files: z.array(z.strictObject({ path: z.string(), fingerprint: z.string() })).max(256),
});
const workSegments = z.strictObject({
  version: z.literal(1),
  limits: z.strictObject({
    revision: z.string(),
    maxToolRounds: z.number().int(),
    maxSegments: z.number().int(),
    contextThresholdPercent: z.number().int(),
  }),
  baseline: evidence,
  anchor,
  active: z.strictObject({
    index: z.number().int().positive(),
    startedAtRequest: z.number().int().nonnegative(),
    toolRounds: z.number().int().nonnegative(),
  }),
  archives: z
    .array(
      z.strictObject({
        index: z.number().int().positive(),
        anchor,
        startedAtRequest: z.number().int().nonnegative(),
        endedAtRequest: z.number().int().positive(),
        messages: z.array(message).min(1),
        intermediateNotes: z.array(z.number().int().nonnegative()).optional(),
        handoff: z.strictObject({
          version: z.literal(1),
          nextTask: z.string().min(1).max(1000),
          evidence,
          completedActions: z.number().int().nonnegative(),
          receipts: z
            .array(
              z.strictObject({
                actionId: z.string().min(1),
                toolName: z.string().min(1),
                target: z.string().max(1000).optional(),
                isError: z.boolean(),
                output: z.string().max(512),
              }),
            )
            .max(6)
            .optional(),
        }),
      }),
    )
    .max(15),
});
const schema = z
  .object({
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
    purpose: z
      .enum(['coordination', 'implementation', 'review', 'research', 'environment', 'delivery'])
      .optional(),
    scope,
    assignment: z
      .object({
        roleId: z.string(),
        allowedPaths: z.array(z.string()),
        protectedPaths: z.array(z.string()),
      })
      .optional(),
    scopeRevisions: z
      .array(z.object({ revision: z.number().int().positive(), scope, instructions: z.string() }))
      .optional(),
    messages: z.array(message),
    intermediateNotes: z.array(z.number().int().nonnegative()).optional(),
    workSegments: workSegments.optional(),
    generation: z
      .strictObject({
        requestId: z.string().min(1).max(256),
        outcome: z.enum(['pending', 'completed', 'unknown']),
      })
      .optional(),
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
  })
  .superRefine((session, ctx) => {
    if (session.purpose === 'review' && (!session.scope.readOnly || session.assignment))
      ctx.addIssue({
        code: 'custom',
        path: ['purpose'],
        message: 'A reviewer must be a read-only service session without a worker assignment.',
      });
    const notes = session.intermediateNotes || [];
    if (
      notes.some(
        (index, position) =>
          (position > 0 && index <= notes[position - 1]) ||
          session.messages[index]?.role !== 'assistant' ||
          !!session.messages[index]?.toolCalls?.length ||
          session.messages[index + 1]?.role !== 'user',
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['intermediateNotes'],
        message:
          'Intermediate notes must be unique ordered no-tool assistant messages followed by a user message.',
      });
  });

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function invalidSegment(message: string): never {
  throw new DomainError('INVALID_CHECKPOINT', message);
}
function validateNotes(messages: ManagedSession['messages'], notes: number[] = []) {
  if (
    notes.some(
      (index, position) =>
        (position > 0 && index <= notes[position - 1]) ||
        messages[index]?.role !== 'assistant' ||
        !!messages[index]?.toolCalls?.length ||
        messages[index + 1]?.role !== 'user',
    )
  )
    invalidSegment('An archived intermediate note has invalid provenance.');
}
function validateSegmentCheckpoint(session: ManagedSession) {
  const state = session.workSegments;
  if (!state) return;
  validateSegmentLimits(state.limits);
  validateSegmentEvidence(state.baseline);
  if (
    state.active.index !== state.archives.length + 1 ||
    state.active.index > state.limits.maxSegments ||
    state.active.startedAtRequest > session.requests ||
    state.active.toolRounds > session.requests - state.active.startedAtRequest
  )
    invalidSegment('The active work segment has invalid lifetime counters.');
  const revisions = session.scopeRevisions || [];
  const validateAnchor = (value: typeof state.anchor) => {
    const revision = revisions.find((item) => item.revision === value.scopeRevision);
    if (!revision || revision.instructions !== value.instructions)
      invalidSegment('A work segment lost its frozen instruction revision.');
  };
  validateAnchor(state.anchor);
  const actionIds = new Set<string>(),
    callIds = new Set<string>();
  for (const action of session.actions) {
    if (actionIds.has(action.id) || callIds.has(action.call.id))
      invalidSegment('A work segment contains duplicate action identities.');
    actionIds.add(action.id);
    callIds.add(action.call.id);
    if (action.status === 'completed' && !action.result)
      invalidSegment('A completed action lost its result.');
  }
  let ended = 0,
    completed = 0;
  for (const [position, archive] of state.archives.entries()) {
    validateAnchor(archive.anchor);
    validateSegmentEvidence(archive.handoff.evidence);
    validateNotes(archive.messages, archive.intermediateNotes);
    if (
      archive.index !== position + 1 ||
      archive.startedAtRequest < ended ||
      archive.endedAtRequest <= archive.startedAtRequest ||
      archive.endedAtRequest > session.requests ||
      archive.handoff.completedActions < completed ||
      archive.handoff.completedActions > session.actions.length ||
      session.actions
        .slice(0, archive.handoff.completedActions)
        .some((action) => action.status !== 'completed') ||
      archive.handoff.evidence.baseCommit !== state.baseline.baseCommit ||
      archive.handoff.evidence.headCommit !== state.baseline.headCommit
    )
      invalidSegment('An archived work segment has invalid evidence or lifetime counters.');
    if (
      archive.handoff.receipts &&
      !same(
        archive.handoff.receipts,
        segmentActionReceipts(session.actions.slice(0, archive.handoff.completedActions)),
      )
    )
      invalidSegment('A handoff receipt must match its completed tool action.');
    const pending = new Map<string, ManagedSession['actions'][number]>();
    const seen = new Set<string>();
    for (const item of archive.messages) {
      if (item.role === 'tool') {
        const action = item.toolCallId ? pending.get(item.toolCallId) : undefined;
        if (
          !action ||
          action.result?.content !== item.content ||
          item.toolName !== action.call.name
        )
          invalidSegment('An archived tool result is missing its completed action receipt.');
        pending.delete(item.toolCallId!);
        continue;
      }
      if (pending.size) invalidSegment('An archive split a required tool-result chain.');
      if (item.toolCalls?.length) {
        if (item.role !== 'assistant') invalidSegment('Only an assistant may request tools.');
        for (const requested of item.toolCalls) {
          const action = session.actions
            .slice(0, archive.handoff.completedActions)
            .find((entry) => entry.call.id === requested.id);
          if (
            !action ||
            action.status !== 'completed' ||
            !same(action.call, requested) ||
            seen.has(requested.id)
          )
            invalidSegment('An archived tool call is missing its completed action receipt.');
          seen.add(requested.id);
          pending.set(requested.id, action);
        }
      }
    }
    const last = archive.messages.at(-1);
    if (pending.size || last?.role !== 'assistant' || last.toolCalls?.length)
      invalidSegment('A work segment was archived before its model round settled.');
    const closing = parseSegmentClosing(last.content);
    if (closing.status !== 'continue' || closing.nextTask !== archive.handoff.nextTask)
      invalidSegment('The archived closing reply does not match its next-task proposal.');
    ended = archive.endedAtRequest;
    completed = archive.handoff.completedActions;
  }
  if (state.active.startedAtRequest < ended)
    invalidSegment('The active segment rewound the archived request count.');
}

/** Segmentation may rotate context, but never rewrite completed private history or lifetime charges. */
function validateTransition(previous: ManagedSession | undefined, next: ManagedSession) {
  if (!previous || (!previous.workSegments && !next.workSegments)) return;
  if (previous.workSegments && !next.workSegments)
    invalidSegment('The work segment archive cannot be removed.');
  if (
    previous.id !== next.id ||
    previous.runtimeId !== next.runtimeId ||
    previous.providerId !== next.providerId ||
    previous.providerRevision !== next.providerRevision ||
    previous.requestedModel !== next.requestedModel ||
    previous.purpose !== next.purpose ||
    !same(previous.limits, next.limits) ||
    !same(previous.assignment, next.assignment) ||
    next.requests < previous.requests ||
    (Object.keys(previous.usage) as (keyof ManagedSession['usage'])[]).some(
      (key) => next.usage[key] < previous.usage[key],
    ) ||
    next.actions.length < previous.actions.length
  )
    invalidSegment('A segmented session cannot reset identity, limits or cumulative accounting.');
  if (
    !same(
      previous.scopeRevisions || [],
      (next.scopeRevisions || []).slice(0, previous.scopeRevisions?.length || 0),
    ) ||
    (next.scopeRevisions?.length || 0) < (previous.scopeRevisions?.length || 0) ||
    (next.scopeRevisions?.length || 0) > (previous.scopeRevisions?.length || 0) + 1
  )
    invalidSegment('A segmented session cannot rewrite its instruction or scope history.');
  if (!same(previous.scope, next.scope)) {
    const revision = next.scopeRevisions?.at(-1);
    if (
      next.scopeRevisions?.length !== (previous.scopeRevisions?.length || 0) + 1 ||
      revision?.revision !== (previous.scopeRevisions?.at(-1)?.revision || 0) + 1 ||
      !same(revision?.scope, next.scope) ||
      previous.scope.projectId !== next.scope.projectId ||
      previous.scope.runId !== next.scope.runId ||
      previous.scope.ownerRunId !== next.scope.ownerRunId ||
      previous.scope.sessionId !== next.scope.sessionId ||
      previous.scope.workspace !== next.scope.workspace ||
      previous.scope.baseCommit !== next.scope.baseCommit ||
      previous.scope.readOnly !== next.scope.readOnly
    )
      invalidSegment('A scope change requires an explicit consistent instruction revision.');
  }
  for (const [index, action] of previous.actions.entries()) {
    const candidate = next.actions[index];
    if (
      action.id !== candidate.id ||
      action.turnId !== candidate.turnId ||
      !same(action.call, candidate.call) ||
      (action.status !== 'pending' && !same(action, candidate)) ||
      (action.status === 'pending' && candidate.status === 'pending' && !same(action, candidate))
    )
      invalidSegment('A segmented session cannot rewrite an action receipt.');
  }
  if (previous.generation) {
    const before = previous.generation,
      after = next.generation;
    if (
      !after ||
      (before.outcome === 'unknown' && !same(before, after)) ||
      (before.outcome === 'pending' && before.requestId !== after.requestId) ||
      (before.requestId === after.requestId &&
        before.outcome === 'completed' &&
        after.outcome !== 'completed') ||
      (before.requestId !== after.requestId &&
        (before.outcome !== 'completed' ||
          after.outcome !== 'pending' ||
          next.requests <= previous.requests))
    )
      invalidSegment('An unresolved generation cannot be erased or automatically replayed.');
  }
  const before = previous.workSegments,
    after = next.workSegments;
  if (!before || !after) return;
  if (
    !same(before.limits, after.limits) ||
    !same(before.baseline, after.baseline) ||
    after.archives.length < before.archives.length ||
    after.archives.length > before.archives.length + 1 ||
    !same(before.archives, after.archives.slice(0, before.archives.length))
  )
    invalidSegment('The work segment archive and its frozen policy are append-only.');
  if (after.archives.length === before.archives.length + 1) {
    const archive = after.archives.at(-1)!;
    if (
      previous.cancelRequested ||
      next.cancelRequested ||
      next.generation?.outcome !== 'completed' ||
      next.actions.some((action) => action.status !== 'completed') ||
      !same(previous.scope, next.scope) ||
      !same(before.anchor, after.anchor) ||
      !same(archive.anchor, before.anchor) ||
      archive.index !== before.active.index ||
      archive.startedAtRequest !== before.active.startedAtRequest ||
      archive.endedAtRequest !== next.requests ||
      archive.handoff.completedActions !== next.actions.length ||
      !same(previous.messages, archive.messages.slice(0, previous.messages.length)) ||
      after.active.index !== before.active.index + 1 ||
      after.active.startedAtRequest !== next.requests ||
      after.active.toolRounds !== 0 ||
      !same(next.messages, segmentMessages(after.anchor, next.scope, archive.handoff)) ||
      next.intermediateNotes?.length
    )
      invalidSegment(
        'A context rollover must atomically preserve a settled step and its frozen assignment.',
      );
  } else {
    if (
      !same(previous.messages, next.messages.slice(0, previous.messages.length)) ||
      !same(
        previous.intermediateNotes || [],
        (next.intermediateNotes || []).slice(0, previous.intermediateNotes?.length || 0),
      )
    )
      invalidSegment('An active work segment cannot erase conversation or note provenance.');
    if (
      after.active.index !== before.active.index ||
      after.active.startedAtRequest !== before.active.startedAtRequest
    )
      invalidSegment('The active work segment cannot change without an archive.');
    if (same(before.anchor, after.anchor)) {
      if (after.active.toolRounds < before.active.toolRounds)
        invalidSegment('The active work step cannot reset its tool-round count.');
    } else if (
      before.anchor.turnId === after.anchor.turnId ||
      after.active.toolRounds !== 0 ||
      next.requests !== previous.requests ||
      after.anchor.scopeRevision !== next.scopeRevisions?.at(-1)?.revision
    )
      invalidSegment('Only an explicit new turn can refresh the frozen work-step task.');
  }
}

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
    return this.read(filename, id);
  }
  private async read(filename: string, id: string) {
    try {
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new DomainError('UNSAFE_CHECKPOINT', 'A checkpoint cannot be a symlink.');
      const session = schema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      if (session.id !== id)
        throw new DomainError('INVALID_CHECKPOINT', 'Checkpoint identity mismatch.');
      validateSegmentCheckpoint(session);
      return session as ManagedSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(session: ManagedSession) {
    const filename = this.filename(session.id);
    const next = schema.parse(structuredClone(session));
    validateSegmentCheckpoint(next);
    const bytes = JSON.stringify(next);
    const work = this.queue.then(async () => {
      await this.prepare();
      validateTransition(await this.read(filename, next.id), next);
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
