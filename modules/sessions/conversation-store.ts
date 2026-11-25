import { randomUUID } from 'node:crypto';
import type { RecordStore, StorageEngine } from '../storage/record-store.ts';
import type {
  Session,
  SessionConversation,
  SessionHistory,
  SessionHistoryQuery,
  SessionMessage,
  SessionStore,
} from './session.ts';

// One namespace lets the adapter commit the header and new messages atomically.
interface ConversationRecord extends Partial<Omit<Session, 'id'>> {
  id: string;
  sessionId: string;
  sequence: number;
  message?: SessionMessage;
}

const metadata = (record: ConversationRecord): Session => {
  const { sessionId: _owner, sequence: _position, message: _message, ...session } = record;

  return session as Session;
};

/** Persists only new messages during execution; metadata queries never read transcripts. */
export class ConversationStore implements SessionStore {
  private records: RecordStore<ConversationRecord>;
  private legacy: RecordStore<SessionConversation>;

  /** Opens module-owned state and the one-time source of existing conversation data. */
  constructor(input: { storage: StorageEngine }) {
    this.records = input.storage.records('conversations', {
      indexes: [
        ['sessionId', 'sequence'],
        ['sequence', 'runId', 'status'],
      ],
    });
    this.legacy = input.storage.records('sessions');
  }

  /** Reads one header without reading messages. */
  async get(id: string): Promise<Session | undefined> {
    const record = await this.records.get(id);

    if (!record)
      return undefined;

    return metadata(record);
  }

  /** Restricts selection in the adapter, before records are deserialized. */
  async list(input: { runId?: string; status?: string } = {}): Promise<Session[]> {
    const records = await this.records.list({
      where: { sequence: -1, ...input },
    });

    return records.map(metadata);
  }

  /** Returns at most one requested page in chronological order. */
  async history(input: SessionHistoryQuery): Promise<SessionHistory> {
    const session = await this.get(input.sessionId);
    const limit = input.limit ?? 50;
    const descending = input.after === undefined;
    const records = await this.records.list({
      where: { sessionId: input.sessionId },
      orderBy: 'sequence',
      descending,
      before: Math.min(input.before ?? Infinity, session?.messageCount ?? 0),
      after: input.after ?? -1,
      limit,
    });

    if (descending)
      records.reverse();

    return {
      messages: records.map((record) => record.message!),
      start: records[0]?.sequence ?? session?.messageCount ?? 0,
      total: session?.messageCount ?? 0,
    };
  }

  /** Loads only this selected conversation, in bounded storage reads. */
  async load(id: string): Promise<SessionConversation | undefined> {
    const session = await this.get(id);

    if (!session)
      return undefined;

    const messages: SessionMessage[] = [];
    while (messages.length < session.messageCount) {
      const page = await this.history({
        sessionId: id,
        after: messages.length - 1,
        limit: Math.min(250, session.messageCount - messages.length),
      });

      if (!page.messages.length)
        break;

      messages.push(...page.messages);
    }

    return { ...session, messages };
  }

  /** Commits the current header and appended messages in one adapter transaction. */
  async append(input: { session: Session; messages: SessionMessage[] }): Promise<void> {
    const { session, messages } = input;
    await this.records.write({
      save: this.entries({
        session,
        messages,
      }),
    });
  }

  /** Replaces history only for migration or repair of an interrupted exchange. */
  async replace(conversation: SessionConversation): Promise<void> {
    const { messages, ...session } = conversation;
    await this.records.write({
      delete: { sessionId: session.id },
      save: this.entries({
        session: { ...session, messageCount: messages.length },
        messages,
      }),
    });
  }

  /** Updates metadata against the latest record, independently of transcript appends. */
  async patch(input: {
    id: string;
    changes: Partial<Omit<Session, 'id'>>;
  }): Promise<Session | undefined> {
    const record = await this.records.patch(input);

    if (!record)
      return undefined;

    return metadata(record);
  }

  /** Removes a header and all messages atomically. */
  async delete(id: string): Promise<void> {
    await this.records.write({
      delete: { sessionId: id },
    });
  }

  /** Copies existing histories once, preserving message identities and private continuations. */
  async migrate(): Promise<void> {
    for (const previous of await this.legacy.list()) {
      // A crash after the copy must not overwrite newer conversation data on restart.
      if (!(await this.get(previous.id))) {
        const messages = previous.messages.map((message) => ({
          ...message,
          id: message.id ?? randomUUID(),
        }));
        const latest = messages
          .slice()
          .reverse()
          .find((message) => message.role === 'assistant');
        await this.replace({
          ...previous,
          preview: previous.preview ?? latest?.content.slice(0, 500),
          messages,
        });
      }

      await this.legacy.delete(previous.id);
    }
  }

  private entries(input: { session: Session; messages: SessionMessage[] }): ConversationRecord[] {
    const { session, messages } = input;
    const start = session.messageCount - messages.length;

    return [
      { ...session, sessionId: session.id, sequence: -1 },
      ...messages.map((message, index) => ({
        id: session.id + ':' + (start + index),
        sessionId: session.id,
        sequence: start + index,
        message,
      })),
    ];
  }
}
