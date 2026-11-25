import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Commands } from '../commands/command.ts';
import type { Notifications } from '../events/notifications.ts';
import type { Projects } from '../projects/project.ts';
import type { Runs } from '../runs/run.ts';
import type { Preview, PreviewOutcome, Previews, PreviewStore } from './preview.ts';

/** Owns foreground server commands without attaching their lifetime to a session. */
export class PreviewService implements Previews {
  private store: PreviewStore;
  private runs: Runs;
  private projects: Projects;
  private commands: Commands;
  private events: Notifications;
  private active = new Map<
    string,
    { controller: AbortController; settled: Promise<void>; preview: Preview }
  >();
  private starting = new Set<Promise<void>>();
  private ports = new Set<number>();
  private closing = false;

  /** Uses the ordinary isolated command adapter, not an unowned detached shell. */
  constructor(input: {
    store: PreviewStore;
    runs: Runs;
    projects: Projects;
    commands: Commands;
    events: Notifications;
  }) {
    this.store = input.store;
    this.runs = input.runs;
    this.projects = input.projects;
    this.commands = input.commands;
    this.events = input.events;
  }

  /** Reads the current observation and returns a detached value. */
  async get(input: { id: string }): Promise<Preview | undefined> {
    return structuredClone(this.active.get(input.id)?.preview ?? (await this.store.get(input.id)));
  }

  /** Lists process observations, never process objects or environment credentials. */
  async list(input: { runId?: string } = {}): Promise<Preview[]> {
    return (await this.store.list())
      .filter((preview) => !input.runId || preview.runId === input.runId)
      .map((preview) => structuredClone(this.active.get(preview.id)?.preview ?? preview));
  }

  /** Reserves startup before asynchronous lookups, so application shutdown can join it. */
  async start(input: {
    runId: string;
    command: string;
    env?: Record<string, string>;
    port?: number;
  }): Promise<PreviewOutcome> {
    if (this.closing) return { ok: false, error: 'Preview service is closed.' };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.starting.add(pending);
    try {
      return await this.launch({ ...input, env: input.env ? { ...input.env } : undefined });
    } finally {
      this.starting.delete(pending);
      release();
    }
  }

  private async launch(input: {
    runId: string;
    command: string;
    env?: Record<string, string>;
    port?: number;
  }): Promise<PreviewOutcome> {
    const run = await this.runs.get({ id: input.runId });
    if (!run) return { ok: false, error: 'Run not found.' };
    if (!input.command.trim()) return { ok: false, error: 'Enter a foreground preview command.' };
    if (
      input.port !== undefined &&
      (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535)
    )
      return { ok: false, error: 'Preview port must be between 1 and 65535.' };
    const project = await this.projects.get({ id: run.projectId });
    if (!project) return { ok: false, error: 'Project is disconnected.' };
    const reserved = await this.reserve(input.port);
    if (reserved.error) return { ok: false, error: reserved.error };
    const port = reserved.port!;
    if (this.closing) {
      this.ports.delete(port);
      return { ok: false, error: 'Preview service is closed.' };
    }
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const entry = {
      controller,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      preview: {
        id: randomUUID(),
        runId: run.id,
        command: input.command,
        port,
        status: 'starting',
        createdAt: new Date().toISOString(),
      } as Preview,
    };
    this.active.set(entry.preview.id, entry);
    try {
      await this.store.save(entry.preview);
    } catch (error) {
      this.active.delete(entry.preview.id);
      this.ports.delete(port);
      resolveSettled();
      throw error;
    }
    this.events.publish({ type: 'preview.updated', data: entry.preview });
    const probe = this.waitUntilListening(entry);
    void (async () => {
      try {
        const result = await this.commands.run({
          workspace: run.workspace,
          source: project.root,
          argv: ['/bin/sh', '-c', input.command],
          env: { ...input.env, PORT: String(port), HOST: '127.0.0.1' },
          readOnly: run.options?.readOnly,
          allowNetwork: true,
          signal: controller.signal,
          onOutput: (output) => {
            entry.preview = { ...entry.preview, ...output };
            this.events.publish({
              type: 'preview.output',
              data: { id: entry.preview.id, runId: run.id },
            });
          },
        });
        entry.preview = {
          ...entry.preview,
          ...result,
          status:
            result.error || (result.exitCode !== 0 && !result.interrupted) ? 'failed' : 'stopped',
          url: undefined,
        };
      } catch (error) {
        entry.preview = {
          ...entry.preview,
          status: controller.signal.aborted ? 'stopped' : 'failed',
          error: controller.signal.aborted
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
          url: undefined,
        };
      } finally {
        controller.abort();
        try {
          await probe;
          await this.store.save(entry.preview);
          this.events.publish({ type: 'preview.updated', data: entry.preview });
        } finally {
          this.active.delete(entry.preview.id);
          this.ports.delete(port);
          resolveSettled();
        }
      }
    })().catch((error) =>
      this.events.publish({
        type: 'preview.error',
        data: {
          id: entry.preview.id,
          error: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    return { ok: true, preview: structuredClone(entry.preview) };
  }

  /** Stops only the selected process group and waits for its final observation. */
  async stop(input: { id: string }): Promise<void> {
    const entry = this.active.get(input.id);
    if (entry) {
      entry.controller.abort();
      await entry.settled;
    }
  }

  /** A restart preserves observations but never replays an old server command. */
  async recover(): Promise<void> {
    for (const preview of await this.store.list())
      if (['starting', 'running'].includes(preview.status))
        await this.store.save({ ...preview, status: 'interrupted', url: undefined });
  }

  /** Cancels startup and live processes before shared command environments are released. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.starting]);
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.all([...this.active.values()].map((entry) => entry.settled));
  }

  private async reserve(port?: number): Promise<{ port?: number; error?: string }> {
    if (port && this.ports.has(port)) return { error: 'Preview port is already in use.' };
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port ?? 0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Preview did not receive a port.');
      if (this.ports.has(address.port))
        return { error: 'Preview port is already reserved. Try again.' };
      this.ports.add(address.port);
      return { port: address.port };
    } catch (error) {
      if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return { error: 'Preview port is unavailable.' };
      throw error;
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async waitUntilListening(entry: {
    controller: AbortController;
    preview: Preview;
  }): Promise<void> {
    while (!entry.controller.signal.aborted) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: entry.preview.port });
        socket.setTimeout(300);
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (ready && !entry.controller.signal.aborted) {
        entry.preview = {
          ...entry.preview,
          status: 'running',
          url: `http://127.0.0.1:${entry.preview.port}`,
        };
        this.events.publish({ type: 'preview.updated', data: entry.preview });
        return;
      }
      await delay(200, undefined, { signal: entry.controller.signal }).catch(() => {});
    }
  }
}
