import type { ReviewSettings } from './review.ts';

/** Optional launch overrides. Omission inherits application defaults; empty instructions override them. */
export interface LaunchOptions {
  modelId?: string;
  instructions?: string;
  review?: ReviewSettings;
}

/** Reusable launch data, copied into a run rather than referenced by it. */
export interface LaunchPreset {
  id: string;
  name: string;
  options: LaunchOptions;
}

/** Omit id to create; supplying id updates only an existing preset. */
export interface PresetInput {
  id?: string;
  name: string;
  options: LaunchOptions;
}

/** Missing update targets are expected unsuccessful outcomes. */
export interface PresetResult {
  ok: boolean;
  preset?: LaunchPreset;
  error?: string;
}

/** Presets own editable data independently of runs, sessions and application defaults. */
export interface Presets {
  /** Lists saved presets without starting work. */
  list(input: {}): Promise<LaunchPreset[]>;
  /** Returns a detached preset, or undefined if absent. */
  get(input: { id: string }): Promise<LaunchPreset | undefined>;
  /** Creates or replaces a preset, preserving its identity on update. */
  save(input: PresetInput): Promise<PresetResult>;
  /** Deletes only the preset; copied launch options remain unchanged. */
  delete(input: { id: string }): Promise<void>;
}
