import type { ModelSamplingSettings } from '../../agent/providers/sampling.ts';
import type { SessionBackend } from '../engines/backend.ts';
import type { AvailableModel } from '../../agent/contracts/model.ts';
import type { RecordStore } from '../storage/record-store.ts';

/** Public settings for one application-wide model connection. */
export interface ModelConfiguration {
  id: string;
  name: string;
  transport: string;
  endpoint?: string;
  model: string;
  contextTokens: number;
  outputTokens: number;
  local: boolean;
  thinking?: boolean;
  reasoningEffort?: string;
  reasoningBudgetTokens?: number;
  sampling?: ModelSamplingSettings;
  capacity?: number;
  retries?: number;
  revision: string;
}

/** One atomic private record, never serialized into selectors or notifications. */
export interface ModelConnection {
  id: string;
  configuration: ModelConfiguration;
  apiKey?: string;
}

/** Transports can be registered by an extension without adding provider branches to sessions. */
export interface ModelTransport {
  id: string;
  name?: string;
  /** Constructs a transport with its own credential resolver. */
  create(input: { configuration: ModelConfiguration; apiKey?: string }): SessionBackend;
}

/** Safe connection metadata, including availability without credentials. */
export interface ModelConfigurationView extends ModelConfiguration {
  hasApiKey: boolean;
  available: boolean;
}

/** Omitted fields retain saved values; null clears an optional provider setting. */
export type ModelConfigurationDraft = Partial<
  Omit<
    ModelConfiguration,
    'revision' | 'capacity' | 'retries' | 'reasoningEffort' | 'reasoningBudgetTokens' | 'sampling'
  >
> & {
  capacity?: number | null;
  retries?: number | null;
  reasoningEffort?: string | null;
  reasoningBudgetTokens?: number | null;
  sampling?: ModelSamplingSettings | null;
};

/** Editable connection settings with working defaults. */
export interface ModelConfigurationInput {
  configuration: ModelConfigurationDraft & Pick<ModelConfiguration, 'name' | 'transport' | 'model'>;
  apiKey?: string | null;
  default?: boolean;
}

/** A configuration error is ordinary feedback, not an application crash. */
export interface ModelConfigurationResult {
  ok: boolean;
  configuration?: ModelConfigurationView;
  error?: string;
}

/** Discovery can use an unsaved connection, preserving credentials of an existing one when omitted. */
export interface ModelDiscoveryInput {
  configuration: ModelConfigurationDraft & Pick<ModelConfiguration, 'transport'>;
  apiKey?: string | null;
}

/** An unavailable catalogue does not prevent entering a model ID manually. */
export interface ModelDiscoveryResult {
  ok: boolean;
  models?: AvailableModel[];
  error?: string;
}

/** Public configuration API, separate from inference routing. */
export interface ModelConfigurations {
  /** Lists registered implementations without constructing or contacting them. */
  transports(): { id: string; name: string }[];
  /** Reads safe settings. */
  list(): Promise<ModelConfigurationView[]>;
  /** Saves settings and optionally replaces a private credential. */
  save(input: ModelConfigurationInput): Promise<ModelConfigurationResult>;
  /** Queries available IDs without saving a connection or starting inference. */
  discover(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult>;
  /** Selects the application default for new conversations. */
  select(input: { id: string }): Promise<boolean>;
  /** Removes settings and credentials without deleting historical conversations. */
  delete(input: { id: string }): Promise<void>;
  /** Cancels and joins pending catalogue requests before storage and native processes close. */
  close(): Promise<void>;
}

/** The model feature owns its private connection records. */
export interface ModelConnectionStore extends RecordStore<ModelConnection> {}
