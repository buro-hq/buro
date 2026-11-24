/** Application defaults are overridden explicitly by a run, without a configuration hierarchy. */
export interface ApplicationSettings {
  id: string;
  defaultModelId?: string;
  instructions: string;
}

/** Defaults are independent of project and agent identities. */
export interface Settings {
  /** Reads persisted defaults or working initial values. */
  get(): Promise<ApplicationSettings>;
  /** Changes only explicitly supplied defaults. */
  update(input: Partial<Omit<ApplicationSettings, 'id'>>): Promise<ApplicationSettings>;
}
