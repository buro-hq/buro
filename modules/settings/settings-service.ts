import type { RecordStore } from '../storage/record-store.ts';
import type { Notifications } from '../events/notifications.ts';
import type { ApplicationSettings, Settings } from './settings.ts';
import { defaultInstructions } from './defaults.ts';

/** Owns application-wide defaults. */
export class SettingsService implements Settings {
  private store: RecordStore<ApplicationSettings>;
  private events: Notifications;

  /** Connects application settings storage and notifications. */
  constructor(input: { store: RecordStore<ApplicationSettings>; events: Notifications }) {
    this.store = input.store;
    this.events = input.events;
  }

  /** Reads initial values without creating a fake project or connection. */
  async get(): Promise<ApplicationSettings> {
    return (
      (await this.store.get('application')) ?? {
        id: 'application',
        instructions: defaultInstructions,
      }
    );
  }

  /** Stores changes without changing unrelated defaults. */
  async update(input: Partial<Omit<ApplicationSettings, 'id'>>): Promise<ApplicationSettings> {
    const settings = (await this.store.patch({
      id: 'application',
      initial: await this.get(),
      changes: input,
    }))!;
    this.events.publish({ type: 'settings.updated', data: settings });
    return settings;
  }
}
