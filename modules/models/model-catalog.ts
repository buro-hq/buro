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
} from './model-configuration.ts';

/** Owns persisted connections and activates them through replaceable transport factories. */
export class ModelCatalog implements ModelConfigurations {
  private store: ModelConnectionStore;
  private models: Models;
  private settings: Settings;
  private events: Notifications;
  private transports: Map<string, ModelTransport>;

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
    this.transports = new Map(input.transports.map((transport) => [transport.id, transport]));
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
    if (settings.defaultModelId) this.models.select({ id: settings.defaultModelId });
  }

  /** Lists connection settings without disclosing credential contents. */
  async list(): Promise<ModelConfigurationView[]> {
    return (await this.store.list()).map(({ configuration, apiKey }) => ({
      ...configuration,
      hasApiKey: !!apiKey,
      available: !!this.models.get({ id: configuration.id }),
    }));
  }

  /** Persists validated boundary input and replaces a transport without changing session identity. */
  async save(input: ModelConfigurationInput): Promise<ModelConfigurationResult> {
    const previous = input.configuration.id
      ? await this.store.get(input.configuration.id)
      : undefined;
    const configuration = {
      contextTokens: 32768,
      outputTokens: 8192,
      local: true,
      thinking: true,
      ...previous?.configuration,
      ...structuredClone(input.configuration),
      id: input.configuration.id ?? randomUUID(),
      revision: randomUUID(),
    };
    const transport = this.transports.get(configuration.transport);
    if (!transport) return { ok: false, error: 'Model transport is unavailable.' };
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
    const apiKey = input.apiKey === undefined ? previous?.apiKey : input.apiKey || undefined;
    // Construct before persisting so invalid endpoints do not become active settings.
    let backend;
    try {
      backend = transport.create({ configuration, apiKey });
    } catch (error) {
      if (isProviderFailure(error) && error.outcome === 'not-dispatched')
        return { ok: false, error: error.message };
      throw error;
    }
    await this.store.save({ id: configuration.id, configuration, apiKey });
    this.models.register({ ...configuration, backend, default: input.default });
    if (input.default || !(await this.settings.get()).defaultModelId)
      await this.settings.update({ defaultModelId: configuration.id });
    const view = { ...configuration, hasApiKey: !!apiKey, available: true };
    this.events.publish({ type: 'model.saved', data: view });
    return { ok: true, configuration: view };
  }

  /** Selects a default for new sessions; existing conversations retain their model. */
  async select(input: { id: string }): Promise<boolean> {
    if (!this.models.get(input)) return false;
    await this.settings.update({ defaultModelId: input.id });
    return this.models.select(input);
  }

  /** Removes a connection and its private credential; history remains available. */
  async delete(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.models.remove(input);
    if ((await this.settings.get()).defaultModelId === input.id)
      await this.settings.update({ defaultModelId: this.models.get()?.id });
    this.events.publish({ type: 'model.deleted', data: input });
  }

  private async activate(id: string): Promise<void> {
    const connection = await this.store.get(id);
    const configuration = connection?.configuration;
    const transport = configuration && this.transports.get(configuration.transport);
    if (!configuration || !transport) return;
    this.models.register({
      ...configuration,
      backend: transport.create({ configuration, apiKey: connection?.apiKey }),
    });
  }
}
