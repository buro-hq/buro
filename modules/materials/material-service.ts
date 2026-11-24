import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import { materialLoaders } from './loaders.ts';
import type {
  Material,
  MaterialRecord,
  MaterialStore,
  MaterialLoader,
  MaterialOutcome,
  Materials,
} from './material.ts';

function metadata(record: MaterialRecord): Material {
  const { text: _text, contentBase64: _bytes, ...material } = record;
  return material;
}

/** Owns context copies; format selection is ordinary registration order with working defaults. */
export class MaterialService implements Materials {
  private store: MaterialStore;
  private events: Notifications;
  private loaders: MaterialLoader[];

  /** Selects the feature store and optional format readers, with built-ins as defaults. */
  constructor(input: { store: MaterialStore; events: Notifications; loaders?: MaterialLoader[] }) {
    this.store = input.store;
    this.events = input.events;
    this.loaders = [...(input.loaders ?? materialLoaders())];
  }

  /** Lists metadata without reading from the user's original files. */
  async list(input: { projectId: string; taskId?: string }): Promise<Material[]> {
    return (await this.store.list())
      .filter(
        (record) =>
          record.projectId === input.projectId &&
          (!input.taskId || !record.taskId || record.taskId === input.taskId),
      )
      .map(metadata);
  }

  /** Reads metadata without returning document text or bytes. */
  async get(input: { id: string }): Promise<Material | undefined> {
    const record = await this.store.get(input.id);
    return record ? metadata(record) : undefined;
  }

  /** Saves uploaded content as one atomic record and emits only metadata. */
  async upload(input: {
    projectId: string;
    taskId?: string;
    name: string;
    contentBase64: string;
    signal?: AbortSignal;
  }): Promise<MaterialOutcome> {
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.toString('base64') !== input.contentBase64)
      return { ok: false, error: 'The uploaded file is not valid base64.' };
    const loader = this.loaders.find((loader) =>
      loader.matches({ name: input.name, bytes: new Uint8Array(bytes) }),
    );
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const loaded = loader
      ? await loader.load({ name: input.name, bytes: new Uint8Array(bytes), signal })
      : {
          mimeType: 'application/octet-stream',
          note: 'Original retained; no text reader is configured for this format.',
        };
    signal.throwIfAborted();
    const record: MaterialRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      name: input.name,
      mimeType: loaded.mimeType,
      textAvailable: loaded.text !== undefined,
      note: loaded.note,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
      contentBase64: input.contentBase64,
      text: loaded.text,
    };
    await this.store.save(record);
    const material = metadata(record);
    this.events.publish({ type: 'material.uploaded', data: material });
    return { ok: true, material };
  }

  /** Reads explicit line ranges so large documents do not displace the current task. */
  async read(input: { id: string; line?: number; count?: number }): Promise<MaterialOutcome> {
    const record = await this.store.get(input.id);
    if (!record) return { ok: false, error: 'Material not found.' };
    if (record.text === undefined)
      return {
        ok: false,
        material: metadata(record),
        error: record.note ?? 'Extracted text is unavailable.',
      };
    const line = input.line ?? 1,
      count = input.count ?? 200;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(count) || line < 1 || count < 1)
      return { ok: false, error: 'line and count must be positive integers.' };
    const lines = record.text.split('\n');
    return {
      ok: true,
      material: metadata(record),
      totalLines: lines.length,
      text: lines.slice(line - 1, line - 1 + count).join('\n'),
    };
  }

  /** Returns the original copy without re-extracting or silently changing it. */
  async download(input: { id: string }): Promise<MaterialOutcome> {
    const record = await this.store.get(input.id);
    return record
      ? { ok: true, material: metadata(record), contentBase64: record.contentBase64 }
      : { ok: false, error: 'Material not found.' };
  }

  /** Removes application-owned context without deleting or changing caller files. */
  async delete(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.events.publish({ type: 'material.deleted', data: input });
  }
}
