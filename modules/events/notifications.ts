/** A detached observation, never a workflow command. */
export interface Notification<T = unknown> {
  type: string;
  data: T;
}

/** Producers publish changes; observers cannot undo the producer's work. */
export interface Notifications {
  /** Observes changes until unsubscribed. */
  subscribe(listener: (notification: Notification) => void | Promise<void>): () => void;
  /** Delivers detached change data. */
  publish(notification: Notification): void;
}
