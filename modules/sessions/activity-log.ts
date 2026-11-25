import { randomUUID } from 'node:crypto';
import type { Activity, ActivityHistory, ActivityStore } from './activity.ts';

/** Records and reads activity without requiring event replay to use a session. */
export class ActivityLog implements ActivityHistory {
  private store: ActivityStore;

  /** Connects the log to its own storage namespace. */
  constructor(input: { store: ActivityStore }) {
    this.store = input.store;
  }

  /** Appends one observation and returns its stable diagnostic identity. */
  async append(input: Omit<Activity, 'id' | 'createdAt'>): Promise<Activity> {
    const activity: Activity = {
      ...structuredClone(input),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.store.save(activity);
    return activity;
  }

  /** Returns the observations belonging to a session or run. */
  async list(input: { sessionId?: string; runId?: string } = {}): Promise<Activity[]> {
    return (await this.store.list()).filter(
      (activity) =>
        (!input.sessionId || activity.sessionId === input.sessionId) &&
        (!input.runId || activity.runId === input.runId),
    );
  }
}
