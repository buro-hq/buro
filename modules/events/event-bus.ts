import type { Notification, Notifications } from './notifications.ts';

/** Delivers notifications without giving subscribers ownership of the producer's state. */
export class EventBus implements Notifications {
  private listeners = new Set<(notification: Notification) => void | Promise<void>>();
  private report: (error: unknown) => void;

  /** Selects how failures of observers are reported; they cannot undo completed work. */
  constructor(input: { report?: (error: unknown) => void } = {}) {
    this.report = input.report ?? (() => {});
  }

  /** Observes changes until the returned unsubscribe function is called. */
  subscribe(listener: (notification: Notification) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publishes detached values after the owning module has committed its change. */
  publish(notification: Notification): void {
    for (const listener of this.listeners) {
      try {
        const pending = listener(structuredClone(notification));
        if (pending)
          void pending.catch(this.report);
      } catch (error) {
        this.report(error);
      }
    }
  }
}
