import type { ModelSamplingSettings } from '../../agent/providers/sampling.ts';
import type { SessionBackend } from '../engines/backend.ts';
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
  /** Constructs a transport with its own credential resolver. */
  create(input: { configuration: ModelConfiguration; apiKey?: string }): SessionBackend;
}

/** Safe connection metadata, including availability without credentials. */
export interface ModelConfigurationView extends ModelConfiguration {
  hasApiKey: boolean;
  available: boolean;
}

/** Editable connection settings with working defaults. */
export interface ModelConfigurationInput {
  configuration: Partial<Omit<ModelConfiguration, 'revision'>> &
    Pick<ModelConfiguration, 'name' | 'transport' | 'model'>;
  apiKey?: string | null;
  default?: boolean;
}

/** A configuration error is ordinary feedback, not an application crash. */
export interface ModelConfigurationResult {
  ok: boolean;
  configuration?: ModelConfigurationView;
  error?: string;
}

/** Public configuration API, separate from inference routing. */
export interface ModelConfigurations {
  /** Reads safe settings. */
  list(): Promise<ModelConfigurationView[]>;
  /** Saves settings and optionally replaces a private credential. */
  save(input: ModelConfigurationInput): Promise<ModelConfigurationResult>;
  /** Selects the application default for new conversations. */
  select(input: { id: string }): Promise<boolean>;
  /** Removes settings and credentials without deleting historical conversations. */
  delete(input: { id: string }): Promise<void>;
}

/** The model feature owns its private connection records. */
export interface ModelConnectionStore extends RecordStore<ModelConnection> {}
