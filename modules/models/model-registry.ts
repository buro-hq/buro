import type { ModelMessage } from '../../agent/contracts/model.ts';
import type { RecordStore } from '../storage/record-store.ts';
import type { AdapterState, Model, ModelInfo, Models } from './model.ts';

/** Owns available models; callers explicitly select a model for a session or turn. */
export class ModelRegistry implements Models {
  private models = new Map<string, Model>();
  private defaultId?: string;
  private adapterState?: RecordStore<AdapterState>;

  /** Optionally persists private provider continuation separately from public history. */
  constructor(input: { adapterState?: RecordStore<AdapterState> } = {}) {
    this.adapterState = input.adapterState;
  }

  /** Retains adapter-owned state without adding private data to messages or notifications. */
  async remember(input: {
    sessionId: string;
    messageId: string;
    modelId: string;
    providerRevision: string;
    continuation: unknown;
  }): Promise<void> {
    if (input.continuation === undefined || !this.adapterState)
      return;

    await this.adapterState.save({
      ...input,
      id: `${input.sessionId}:${input.messageId}`,
    });
  }

  /** Attaches only private continuation owned by the currently selected adapter. */
  async context(input: {
    sessionId: string;
    modelId: string;
    providerRevision: string;
    messages: (ModelMessage & { id?: string })[];
  }): Promise<ModelMessage[]> {
    if (!this.adapterState)
      return structuredClone(input.messages);

    return Promise.all(
      input.messages.map(async (message) => {
        const state = message.id
          ? await this.adapterState!.get(`${input.sessionId}:${message.id}`)
          : undefined;
        return state?.modelId === input.modelId && state.providerRevision === input.providerRevision
          ? { ...structuredClone(message), continuation: state.continuation }
          : structuredClone(message);
      }),
    );
  }

  /** Adds or replaces a model; the first registered model becomes the default. */
  register(input: Model & { default?: boolean }): void {
    const {
      default: selected,
      id,
      name,
      backend,
      model: modelId,
      contextTokens,
      outputTokens,
    } = input;
    const model: Model = { id, name, backend, model: modelId, contextTokens, outputTokens };
    this.models.set(model.id, model);
    if (!this.defaultId || selected)
      this.defaultId = model.id;
  }

  /** Returns a selected model, using the application default only when no ID was supplied. */
  get(input: { id?: string } = {}): Model | undefined {
    const model = this.models.get(input.id ?? this.defaultId ?? '');
    return model ? { ...model } : undefined;
  }

  /** Returns safe metadata for model selectors, tools and clients. */
  list(): ModelInfo[] {
    return [...this.models.values()].map(
      ({ id, name, model, backend, contextTokens, outputTokens }) => ({
        id,
        name,
        model,
        backendId: backend.id,
        contextTokens,
        outputTokens,
      }),
    );
  }

  /** Selects the application default without changing existing sessions. */
  select(input: { id: string }): boolean {
    if (!this.models.has(input.id))
      return false;

    this.defaultId = input.id;
    return true;
  }

  /** Removes a transport and selects another default when needed. */
  remove(input: { id: string }): void {
    this.models.delete(input.id);
    if (this.defaultId === input.id)
      this.defaultId = this.models.keys().next().value;
  }
}
