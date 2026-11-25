import type { SessionHistory, SessionHistoryQuery } from '../../../modules/sessions/session.ts';

/** Keeps the viewed window while fetching new and older messages in bounded pages. */
export class Transcript {
  private read: (query: SessionHistoryQuery) => Promise<SessionHistory>;
  private sessionId: string;
  private page?: SessionHistory;

  /** Selects one conversation; a new view starts with its most recent messages. */
  constructor(input: {
    sessionId: string;
    read: (query: SessionHistoryQuery) => Promise<SessionHistory>;
  }) {
    this.sessionId = input.sessionId;
    this.read = input.read;
  }

  /** Fetches changes after the viewed tail, including bursts larger than one page. */
  async refresh(): Promise<SessionHistory> {
    if (!this.page) this.page = await this.read({ sessionId: this.sessionId });

    while (true) {
      const end = this.page.start + this.page.messages.length;
      const next = await this.read({ sessionId: this.sessionId, after: end - 1 });

      if (next.total < end) {
        this.page = await this.read({ sessionId: this.sessionId });

        return this.page;
      }

      this.page = {
        ...this.page,
        total: next.total,
        messages: [...this.page.messages, ...next.messages],
      };

      const complete = !next.messages.length || next.start + next.messages.length >= next.total;

      if (complete) return this.page;
    }
  }

  /** Prepends one older page without dropping live messages arriving during the read. */
  async earlier(): Promise<SessionHistory> {
    const before = this.page?.start ?? 0;

    if (!this.page || !before) return this.refresh();

    const previous = await this.read({ sessionId: this.sessionId, before });
    const current = this.page;

    if (current.start === before)
      this.page = {
        start: previous.start,
        total: Math.max(current.total, previous.total),
        messages: [...previous.messages, ...current.messages],
      };

    return this.page;
  }
}
