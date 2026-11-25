import { randomUUID } from 'node:crypto';
import { isProviderFailure } from '../../agent/contracts/provider-errors.ts';
import type { Notifications } from '../events/notifications.ts';
import type { Settings } from '../settings/settings.ts';
import type { Models } from './model.ts';
import type {
  ModelConfigurations,
  ModelConfigurationInput,
  ModelConnectionStore,
  ModelConfigurationView,
  ModelConfigurationResult,
  ModelTransport,
  ModelDiscoveryInput,
  ModelDiscoveryResult,
  ModelConfigurationDraft,
  ModelConfiguration,
} from './model-configuration.ts';

function draft(input: ModelConfigurationDraft): Partial<ModelConfiguration> {
  return Object.fromEntries(
    Object.entries(structuredClone(input)).map(([key, value]) => [
      key,
      value === null ? undefined : value,
    ]),
  );
}

/** Owns persisted connections and activates them through replaceable transport factories. */
export class ModelCatalog implements ModelConfigurations {
  private store: ModelConnectionStore;
  private models: Models;
  private settings: Settings;
  private events: Notifications;
  private factories: Map<string, ModelTransport>;
  private discoveries = new Map<AbortController, Promise<void>>();
  private closing = false;
  private mutations: Promise<void> = Promise.resolve();

  /** Connects safe configuration, private credentials and runtime routing. */
  constructor(input: {
    store: ModelConnectionStore;
    models: Models;
    settings: Settings;
    events: Notifications;
    transports: ModelTransport[];
  }) {
    this.store = input.store;
    this.models = input.models;
    this.settings = input.settings;
    this.events = input.events;
    this.factories = new Map(input.transports.map((transport) => [transport.id, transport]));
  }

  /** Loads stored connections without contacting model endpoints or starting inference. */
  async initialize(): Promise<void> {
    for (const connection of await this.store.list()) {
      try {
        await this.activate(connection.id);
      } catch (error) {
        this.events.publish({
          type: 'model.unavailable',
          data: {
            id: connection.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    const settings = await this.settings.get();
    if (settings.defaultModelId)
      this.models.select({
        id: settings.defaultModelId,
      });
  }

  /** Lists connection settings without disclosing credential contents. */
  async list(): Promise<ModelConfigurationView[]> {
    await this.mutations;
    return (await this.store.list()).map(({ configuration, apiKey }) => ({
      ...configuration,
      hasApiKey: !!apiKey,
      available: !!this.models.get({
        id: configuration.id,
      }),
    }));
  }

  /** Extensions appear in clients through the same catalogue as built-in transports. */
  transports(): { id: string; name: string }[] {
    return [...this.factories.values()].map(({ id, name }) => ({ id, name: name ?? id }));
  }

  /** Reads metadata for a draft connection; no placeholder model is persisted. */
  async discover(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
    if (this.closing)
      return { ok: false, error: 'Model discovery is closed.' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let release!: () => void;
    this.discoveries.set(
      controller,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      return await this.readCatalogue(input, controller.signal);
    } finally {
      clearTimeout(timer);
      this.discoveries.delete(controller);
      release();
    }
  }

  /** Releases catalogue requests owned by this process, including native listing processes. */
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.discoveries.keys())
      controller.abort();
    await Promise.all([this.mutations, ...this.discoveries.values()]);
  }

  private async readCatalogue(
    input: ModelDiscoveryInput,
    signal: AbortSignal,
  ): Promise<ModelDiscoveryResult> {
    await this.mutations;
    const previous = input.configuration.id
      ? await this.store.get(input.configuration.id)
      : undefined;
    const configuration = {
      id: input.configuration.id ?? randomUUID(),
      name: '',
      model: '',
      contextTokens: 32768,
      outputTokens: 8192,
      thinking: true,
      local: true,
      revision: randomUUID(),
      ...previous?.configuration,
      ...draft(input.configuration),
      transport: input.configuration.transport,
    };
    const transport = this.factories.get(configuration.transport);
    if (!transport)
      return { ok: false, error: 'Model transport is unavailable.' };

    const apiKey = input.apiKey === undefined ? previous?.apiKey : input.apiKey || undefined;
    try {
      signal.throwIfAborted();
      const backend = transport.create({
        configuration,
        apiKey,
      });
      if (!backend.listModels)
        return {
          ok: false,
          error: 'This backend does not provide a model catalogue. Enter its model ID directly.',
        };

      return { ok: true, models: await backend.listModels({
        signal,
      }) };
    } catch (error) {
      return {
        ok: false,
        error: signal.aborted
          ? this.closing
            ? 'Model discovery interrupted.'
            : 'Model discovery timed out. You can enter its ID directly.'
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  /** Persists validated boundary input and replaces a transport without changing session identity. */
  async save(input: ModelConfigurationInput): Promise<ModelConfigurationResult> {
    if (this.closing)
      return { ok: false, error: 'Model configuration is closed.' };

    const copy = structuredClone(input);
    return this.mutate(() => this.saveConfiguration(copy));
  }

  private async saveConfiguration(
    input: ModelConfigurationInput,
  ): Promise<ModelConfigurationResult> {
    const previous = input.configuration.id
      ? await this.store.get(input.configuration.id)
      : undefined;
    const configuration = {
      contextTokens: 32768,
      outputTokens: 8192,
      local: true,
      thinking: true,
      ...previous?.configuration,
      ...draft(input.configuration),
      name: input.configuration.name,
      transport: input.configuration.transport,
      model: input.configuration.model,
      id: input.configuration.id ?? randomUUID(),
      revision: randomUUID(),
    };
    const transport = this.factories.get(configuration.transport);
    if (!transport)
      return { ok: false, error: 'Model transport is unavailable.' };

    if (!configuration.name.trim() || !configuration.model.trim())
      return { ok: false, error: 'Model name and model ID are required.' };

    if (
      !Number.isSafeInteger(configuration.contextTokens) ||
      !Number.isSafeInteger(configuration.outputTokens) ||
      configuration.outputTokens < 1 ||
      configuration.contextTokens <= configuration.outputTokens
    )
      return {
        ok: false,
        error: 'Context must be larger than the positive output token allowance.',
      };

    if (
      configuration.capacity !== undefined &&
      (!Number.isSafeInteger(configuration.capacity) || configuration.capacity < 1)
    )
      return { ok: false, error: 'Endpoint capacity must be a positive integer.' };

    if (input.apiKey !== undefined && input.apiKey !== null && /[\r\n\0]/.test(input.apiKey))
      return { ok: false, error: 'API key contains invalid characters.' };

    if (
      configuration.retries !== undefined &&
      (!Number.isSafeInteger(configuration.retries) || configuration.retries < 0)
    )
      return { ok: false, error: 'HTTP retries must be a nonnegative integer.' };

    const apiKey = input.apiKey === undefined ? previous?.apiKey : input.apiKey || undefined;
    // Construct before persisting so invalid endpoints do not become active settings.
    let backend;
    try {
      backend = transport.create({
        configuration,
        apiKey,
      });
    } catch (error) {
      if (isProviderFailure(error) && error.outcome === 'not-dispatched')
        return { ok: false, error: error.message };

      throw error;
    }
    await this.store.save({
      id: configuration.id,
      configuration,
      apiKey,
    });
    this.models.register({
      ...configuration,
      backend,
      default: input.default,
    });
    if (input.default || !(await this.settings.get()).defaultModelId) {
      await this.settings.update({
        defaultModelId: configuration.id,
      });
      this.models.select({
        id: configuration.id,
      });
    }

    const view = { ...configuration, hasApiKey: !!apiKey, available: true };
    this.events.publish({
      type: 'model.saved',
      data: view,
    });
    return { ok: true, configuration: view };
  }

  /** Selects a default for new sessions; existing conversations retain their model. */
  async select(input: { id: string }): Promise<boolean> {
    if (this.closing)
      return false;

    const copy = { ...input };
    return this.mutate(() => this.selectDefault(copy));
  }

  private async selectDefault(input: { id: string }): Promise<boolean> {
    if (!this.models.get(input))
      return false;

    await this.settings.update({
      defaultModelId: input.id,
    });
    return this.models.select(input);
  }

  /** Removes a connection and its private credential; history remains available. */
  async delete(input: { id: string }): Promise<void> {
    if (this.closing)
      throw new Error('Model configuration is closed.');

    const copy = { ...input };
    return this.mutate(() => this.removeConfiguration(copy));
  }

  private async removeConfiguration(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.models.remove(input);
    if ((await this.settings.get()).defaultModelId === input.id)
      await this.settings.update({
        defaultModelId: this.models.get()?.id,
      });

    this.events.publish({
      type: 'model.deleted',
      data: input,
    });
  }

  private async activate(id: string): Promise<void> {
    const connection = await this.store.get(id);
    const configuration = connection?.configuration;
    const transport = configuration && this.factories.get(configuration.transport);
    if (!configuration || !transport)
      return;

    this.models.register({
      ...configuration,
      backend: transport.create({
        configuration,
        apiKey: connection?.apiKey,
      }),
    });
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(work);
    this.mutations = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
}
