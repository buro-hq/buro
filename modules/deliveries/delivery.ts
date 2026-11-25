import type { RecordStore } from '../storage/record-store.ts';

/** An explicit publication, separate from a run's completion and its local result. */
export interface Delivery {
  id: string;
  runId: string;
  publisherId: string;
  title: string;
  status: string;
  createdAt: string;
  revision?: string;
  branch?: string;
  commit?: string;
  workspace?: string;
  url?: string;
  error?: string;
}
export interface DeliveryStore extends RecordStore<Delivery> {}
export interface DeliveryOutcome {
  ok: boolean;
  delivery?: Delivery;
  error?: string;
}

/** Publication adapters own remote mechanics, without deciding whether agent work is finished. */
export interface ResultPublisher {
  id: string;
  name: string;
  /** Publishes the captured patch against an explicit or remote default base. */
  publish(input: {
    id: string;
    root: string;
    patch: string;
    title: string;
    description: string;
    remote: string;
    branch: string;
    base?: string;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; commit?: string; workspace?: string; url?: string; error?: string }>;
}

/** Publication is requested explicitly; restarting the application never replays it. */
export interface Deliveries {
  /** Lists registered publication implementations. */
  publishers(): { id: string; name: string }[];
  /** Reads recorded publications. */
  list(input?: { runId?: string }): Promise<Delivery[]>;
  /** Publishes one captured result. PR descriptions are empty unless explicitly supplied. */
  publish(input: {
    runId: string;
    publisherId?: string;
    title?: string;
    description?: string;
    remote?: string;
    base?: string;
    branch?: string;
    revision?: string;
  }): Promise<DeliveryOutcome>;
  /** Records interrupted publications without assuming whether a remote operation succeeded. */
  recover(): Promise<void>;
  /** Cancels and joins publications owned by this process. */
  close(): Promise<void>;
}
