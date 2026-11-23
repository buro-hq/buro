import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../../core/ports.ts';

type Patch = { path: (string | number)[]; value?: unknown; remove?: true; append?: unknown[] };
type Entry<T> = { session: T; sequence: number; stamp: string; bytes: number; journal: boolean };
const format = 'buro-managed-journal-v1';
const changed = () =>
  new DomainError(
    'CHECKPOINT_CHANGED',
    'Checkpoint storage changed during a write. Reload the saved session.',
  );
const invalid = () => new DomainError('INVALID_CHECKPOINT', 'Invalid managed checkpoint journal.');
const stamp = (stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function delta(before: unknown, after: unknown, location: Patch['path'] = []): Patch[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length) {
    const patches = before.flatMap((value, index) =>
      delta(value, after[index], [...location, index]),
    );
    if (after.length > before.length)
      patches.push({ path: location, append: after.slice(before.length) });
    return patches;
  }
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      b[key] === undefined
        ? a[key] !== undefined
          ? [{ path: [...location, key], remove: true as const }]
          : []
        : delta(a[key], b[key], [...location, key]),
    );
  }
  return [{ path: location, value: after }];
}
function apply<T>(before: T, patches: unknown): T {
  if (!Array.isArray(patches)) throw invalid();
  let next: any = structuredClone(before);
  for (const patch of patches as Patch[]) {
    if (
      !patch ||
      !Array.isArray(patch.path) ||
      patch.path.some(
        (key) => typeof key !== 'string' && !(Number.isSafeInteger(key) && Number(key) >= 0),
      )
    )
      throw invalid();
    const kinds =
      Number(Object.hasOwn(patch, 'value')) +
      Number(patch.remove === true) +
      Number(Object.hasOwn(patch, 'append'));
    if (kinds !== 1) throw invalid();
    let owner = next;
    const parts = patch.append ? patch.path : patch.path.slice(0, -1);
    for (const key of parts) {
      if (!owner || typeof owner !== 'object' || !Object.hasOwn(owner, key)) throw invalid();
      owner = owner[key];
    }
    if (patch.append) {
      if (!Array.isArray(owner) || !Array.isArray(patch.append)) throw invalid();
      for (const item of patch.append) owner.push(item);
    } else if (!patch.path.length) {
      if (patch.remove) throw invalid();
      next = patch.value;
    } else {
      if (!owner || typeof owner !== 'object') throw invalid();
      const key = patch.path.at(-1)!;
      if (
        Array.isArray(owner) &&
        (!Number.isSafeInteger(key) || Number(key) >= owner.length || patch.remove)
      )
        throw invalid();
      if (patch.remove) delete owner[key];
      else
        Object.defineProperty(owner, key, {
          value: patch.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  return next;
}

/** Fsync before acknowledging an append. Replay reconstructs data and never dispatches effects. */
export class CheckpointJournal<T extends { id: string }> {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private cached = new Map<string, Entry<T>>();
  private parse: (value: unknown, previous?: T) => T;
  private transition: (previous: T | undefined, next: T) => void;
  constructor(
    directory: string,
    parse: (value: unknown, previous?: T) => T,
    transition: (previous: T | undefined, next: T) => void,
  ) {
    this.directory = path.resolve(directory);
    this.parse = parse;
    this.transition = transition;
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
  private async read(filename: string, id: string): Promise<Entry<T> | undefined> {
    try {
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new DomainError('UNSAFE_CHECKPOINT', 'A checkpoint cannot be a symlink.');
      const disk = await fs.stat(filename, { bigint: true });
      const cached = this.cached.get(id);
      if (cached?.stamp === stamp(disk)) return cached;
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        if (stamp(await handle.stat({ bigint: true })) !== stamp(disk)) throw changed();
        bytes = await handle.readFile();
        if (stamp(await handle.stat({ bigint: true })) !== stamp(disk)) throw changed();
      } finally {
        await handle.close();
      }
      let session: T,
        sequence = 0,
        validBytes = bytes.length,
        journal = true;
      const source = bytes.toString('utf8');
      const first = source.indexOf('\n');
      let header: any;
      try {
        header = JSON.parse(first < 0 ? source : source.slice(0, first));
      } catch {
        header = JSON.parse(source);
      }
      if (header?.format !== format) {
        session = this.parse(JSON.parse(source));
        journal = false;
      } else {
        if (first < 0 || header.sequence !== 0) throw invalid();
        session = this.parse(header.snapshot);
        validBytes = Buffer.byteLength(source.slice(0, first + 1));
        let position = first + 1;
        while (true) {
          const end = source.indexOf('\n', position);
          if (end < 0) break; // A crash can leave one unacknowledged, incomplete final record.
          const record = JSON.parse(source.slice(position, end));
          if (record.sequence !== sequence + 1) throw invalid();
          const next = this.parse(apply(session, record.patch), session);
          this.transition(session, next);
          session = next;
          sequence = record.sequence;
          validBytes += Buffer.byteLength(source.slice(position, end + 1));
          position = end + 1;
        }
      }
      if (session.id !== id) throw invalid();
      const entry = { session, sequence, bytes: validBytes, stamp: stamp(disk), journal };
      this.cached.set(id, entry);
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached.delete(id);
        return undefined;
      }
      throw error;
    }
  }
  async load(id: string) {
    const filename = this.filename(id);
    await this.queue;
    await this.prepare();
    const entry = await this.read(filename, id);
    return entry ? structuredClone(entry.session) : undefined;
  }
  save(input: T) {
    const captured = structuredClone(input),
      filename = this.filename(input.id);
    const work = this.queue.then(async () => {
      await this.prepare();
      const previous = await this.read(filename, captured.id);
      const next = this.parse(captured, previous?.session);
      this.transition(previous?.session, next);
      const sequence = previous ? previous.sequence + 1 : 0;
      const record = previous
        ? JSON.stringify({ sequence, patch: delta(previous.session, next) }) + '\n'
        : '';
      if (!previous?.journal) {
        const bytes =
          JSON.stringify({ format, sequence: 0, snapshot: previous?.session || next }) +
          '\n' +
          record;
        const temp = filename + '.' + randomUUID() + '.tmp';
        try {
          const handle = await fs.open(temp, 'wx', 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          if (previous && stamp(await fs.stat(filename, { bigint: true })) !== previous.stamp)
            throw changed();
          await fs.rename(temp, filename);
          this.cached.set(next.id, {
            session: next,
            sequence,
            bytes: Buffer.byteLength(bytes),
            stamp: stamp(await fs.stat(filename, { bigint: true })),
            journal: true,
          });
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        return;
      }
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(
          filename,
          constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
        );
        if (stamp(await handle.stat({ bigint: true })) !== previous.stamp) throw changed();
        await handle.truncate(previous.bytes);
        await handle.writeFile(record);
        await handle.sync();
        this.cached.set(next.id, {
          session: next,
          sequence,
          bytes: previous.bytes + Buffer.byteLength(record),
          stamp: stamp(await handle.stat({ bigint: true })),
          journal: true,
        });
      } catch (error) {
        if (handle && !(error instanceof DomainError && error.code === 'CHECKPOINT_CHANGED')) {
          await handle.truncate(previous.bytes).catch(() => {});
          await handle.sync().catch(() => {});
        }
        this.cached.delete(next.id);
        throw error;
      } finally {
        await handle?.close();
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
