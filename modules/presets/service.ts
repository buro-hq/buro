import { randomUUID } from 'node:crypto';
import type { LaunchPreset, PresetInput, PresetResult, Presets } from '#shared/contracts';
import type { RecordStore } from '../storage/record-store.ts';
import type { Notifications } from '../events/notifications.ts';

/** Owns reusable launch data with no dependency on execution or application settings. */
export class PresetService implements Presets {
  private store: RecordStore<LaunchPreset>;
  private events: Notifications;

  /** Connects replaceable record storage and refresh notifications. */
  constructor(input: { store: RecordStore<LaunchPreset>; events: Notifications }) {
    this.store = input.store;
    this.events = input.events;
  }

  /** Returns detached records in storage order. */
  async list(_input: {}): Promise<LaunchPreset[]> {
    return this.store.list();
  }

  /** Reads saved data without resolving settings or starting work. */
  async get(input: { id: string }): Promise<LaunchPreset | undefined> {
    return this.store.get(input.id);
  }

  /** Replaces editable data; an unknown update never creates a new preset. */
  async save(input: PresetInput): Promise<PresetResult> {
    const { id, name, options } = structuredClone(input);
    let preset: LaunchPreset | undefined;
    if (id !== undefined) {
      preset = await this.store.patch({
        id,
        changes: { name, options },
      });
    } else {
      preset = { id: randomUUID(), name, options };
      await this.store.save(preset);
    }

    if (!preset)
      return { ok: false, error: 'Preset not found.' };

    this.events.publish({
      type: 'preset.saved',
      data: preset,
    });
    return { ok: true, preset };
  }

  /** Removes only the reusable record, including when already absent. */
  async delete(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.events.publish({
      type: 'preset.deleted',
      data: input,
    });
  }
}
