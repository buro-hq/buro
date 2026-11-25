/** One authoritative read, including its initial loading state and last failure. */
export interface QueryResult<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

/** Coalesces changes without postponing reads or discarding useful in-flight results. */
export class QuerySubscription<T> {
  private read: () => Promise<T>;
  private update: (result: QueryResult<T>) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private dirty = false;
  private closed = false;
  private data?: T;

  /** Starts the initial read; subsequent changes share one bounded refresh timer. */
  constructor(input: { read: () => Promise<T>; update: (result: QueryResult<T>) => void }) {
    this.read = input.read;
    this.update = input.update;
    void this.load();
  }

  /** Marks this view stale; continuous notifications never reset an existing timer. */
  invalidate(): void {
    if (this.closed)
      return;

    this.dirty = true;
    if (this.running || this.timer)
      return;

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, 50);
  }

  /** Stops observing this query and ignores any response arriving after unmount. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private async load(): Promise<void> {
    this.running = true;
    this.dirty = false;
    try {
      const data = await this.read();
      if (!this.closed) {
        this.data = data;
        this.update({
          data,
          loading: false,
        });
      }
    } catch (error) {
      if (!this.closed)
        this.update({
          data: this.data,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      this.running = false;
      if (this.dirty)
        this.invalidate();
    }
  }
}
