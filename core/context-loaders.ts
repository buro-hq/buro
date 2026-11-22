import { DomainError } from './ports.ts';

export type ContextInput = { name: string; bytes: Uint8Array };
export type LoadedContext = {
  mimeType: string;
  representation: 'text' | 'reference';
  text?: string;
  note?: string;
};
export type ContextLoader = {
  id: string;
  revision: string;
  fallback?: true;
  matches(input: ContextInput): boolean;
  load(input: ContextInput, signal: AbortSignal): Promise<LoadedContext>;
};
export type ResolvedContextLoader = {
  readonly id: string;
  readonly revision: string;
  load(signal: AbortSignal): Promise<LoadedContext>;
};
const maxTextBytes = 8 * 1024 * 1024;
const invalid = () =>
  new DomainError('INVALID_CONTEXT_LOADER', 'A context loader returned invalid content.');
function output(value: LoadedContext): LoadedContext {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) => !['mimeType', 'representation', 'text', 'note'].includes(key),
    ) ||
    typeof value.mimeType !== 'string' ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(value.mimeType) ||
    value.mimeType.length > 200 ||
    !['text', 'reference'].includes(value.representation) ||
    (value.text !== undefined &&
      (typeof value.text !== 'string' ||
        value.text.includes('\0') ||
        new TextEncoder().encode(value.text).length > maxTextBytes)) ||
    (value.representation === 'reference' && value.text !== undefined) ||
    (value.representation === 'text' && typeof value.text !== 'string') ||
    (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 2000))
  )
    throw invalid();
  return {
    mimeType: value.mimeType,
    representation: value.representation,
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.note === undefined ? {} : { note: value.note }),
  };
}

/** Startup-only format dispatch. Callbacks receive copies, never source paths or application ports. */
export class ContextLoaderCatalog {
  #loaders = new Map<string, ContextLoader>();
  #sealed = false;
  register(input: ContextLoader) {
    if (this.#sealed)
      throw new DomainError('CONTEXT_LOADERS_SEALED', 'Context loaders are already sealed.');
    if (
      typeof input.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(input.id) ||
      typeof input.revision !== 'string' ||
      !input.revision.trim() ||
      input.revision.length > 200 ||
      (input.fallback !== undefined && input.fallback !== true) ||
      typeof input.matches !== 'function' ||
      typeof input.load !== 'function'
    )
      throw invalid();
    if (this.#loaders.has(input.id))
      throw new DomainError(
        'CONTEXT_LOADER_EXISTS',
        'A context loader with this ID is already registered.',
      );
    if (input.fallback && [...this.#loaders.values()].some((loader) => loader.fallback))
      throw new DomainError(
        'CONTEXT_LOADER_EXISTS',
        'Only one fallback context loader may be registered.',
      );
    this.#loaders.set(
      input.id,
      Object.freeze({
        id: input.id,
        revision: input.revision,
        ...(input.fallback ? { fallback: true as const } : {}),
        matches: input.matches,
        load: input.load,
      }),
    );
  }
  seal() {
    this.#sealed = true;
    return this;
  }
  assertSealed() {
    if (!this.#sealed)
      throw new DomainError(
        'CONTEXT_LOADERS_UNSEALED',
        'Seal context loaders before importing materials.',
      );
  }
  select(input: ContextInput): ResolvedContextLoader {
    this.assertSealed();
    if (typeof input.name !== 'string' || !input.name || !(input.bytes instanceof Uint8Array))
      throw invalid();
    const name = input.name,
      bytes = new Uint8Array(input.bytes);
    const packet = () => Object.freeze({ name, bytes: new Uint8Array(bytes) });
    const matches = (loader: ContextLoader) => {
      const result = loader.matches(packet());
      if (typeof result !== 'boolean') throw invalid();
      return result;
    };
    const primary = [...this.#loaders.values()].filter(
      (loader) => !loader.fallback && matches(loader),
    );
    if (primary.length > 1)
      throw new DomainError(
        'CONTEXT_LOADER_AMBIGUOUS',
        'More than one context loader accepts this format.',
      );
    const fallback = [...this.#loaders.values()].find((loader) => loader.fallback);
    const loader = primary[0] || (fallback && matches(fallback) ? fallback : undefined);
    if (!loader)
      throw new DomainError(
        'UNSUPPORTED_CONTEXT',
        'The selected material has no supported context loader.',
      );
    return Object.freeze({
      id: loader.id,
      revision: loader.revision,
      load: async (signal: AbortSignal) => {
        signal.throwIfAborted();
        const result = output(await loader.load(packet(), signal));
        signal.throwIfAborted();
        return result;
      },
    });
  }
  async load(input: ContextInput, signal: AbortSignal) {
    const selected = this.select(input);
    return {
      ...(await selected.load(signal)),
      loader: { id: selected.id, revision: selected.revision },
    };
  }
}
