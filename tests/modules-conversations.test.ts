import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from '../modules/storage/sqlite-storage.ts';
import { JsonStorage } from '../modules/storage/json-storage.ts';
import { ConversationStore } from '../modules/sessions/conversation-store.ts';
import type { SessionConversation, SessionMessage } from '../modules/sessions/session.ts';
import { createApplication } from '../modules/application/create-application.ts';
import { Transcript } from '../src/features/runs/transcript.ts';

const conversation = (id: string): SessionConversation => ({
  id,
  runId: 'run-' + id,
  modelId: 'fixture',
  instructions: '',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  messageCount: 1201,
  messages: Array.from({
    length: 1201,
  }, (_, index) => ({
    id: id + '-message-' + index,
    role: index === 0 ? 'system' : index % 2 ? 'user' : 'assistant',
    content: 'Observed message ' + index,
  })),
});

for (const adapter of ['sqlite', 'json']) {
  test(`${adapter}: migration preserves long histories, private identities and paged reads through restart`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-conversations-'));
    const open = () =>
      adapter === 'sqlite'
        ? new SqliteStorage({
            filename: path.join(directory, 'state.sqlite'),
          })
        : new JsonStorage({
            directory,
          });
    let storage = open();
    let store = new ConversationStore({
      storage,
    });
    t.after(async () => {
      await storage.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    const original = conversation('first');
    await storage.records('sessions').save(original);
    await storage.records('model-continuations').save({
      id: 'first:first-message-2',
      continuation: 'private-fixture',
    });
    await store.migrate();
    await store.replace(conversation('unrelated'));
    const selected = await store.list({
      runId: 'run-first',
    });
    assert.equal(selected.length, 1);
    assert.equal('messages' in selected[0], false);
    assert.equal(selected[0].messageCount, 1201);
    const tail = await store.history({
      sessionId: original.id,
    });
    assert.equal(tail.start, 1151);
    assert.deepEqual(tail.messages, original.messages.slice(1151));
    const earlier = await store.history({
      sessionId: original.id,
      before: tail.start,
      limit: 100,
    });
    assert.equal(earlier.start, 1051);
    assert.deepEqual(earlier.messages, original.messages.slice(1051, 1151));
    assert.deepEqual(
      (await store.history({
        sessionId: original.id,
        after: 1198,
        limit: 10,
      })).messages,
      original.messages.slice(1199),
    );
    assert.deepEqual((await store.load(original.id))!.messages, original.messages);
    assert.deepEqual(await storage.records('sessions').list(), []);

    // An interrupted migration must not replace already migrated and subsequently edited data.
    await storage.records('sessions').save(original);
    await store.patch({
      id: original.id,
      changes: { modelId: 'selected-after-migration' },
    });
    await store.migrate();
    await storage.close();
    storage = open();
    store = new ConversationStore({
      storage,
    });
    assert.equal((await store.get(original.id))!.modelId, 'selected-after-migration');
    assert.deepEqual((await store.load(original.id))!.messages, original.messages);
    assert.equal(
      (await storage
        .records<{ id: string; continuation: string }>('model-continuations')
        .get('first:first-message-2'))!.continuation,
      'private-fixture',
    );
    await store.delete(original.id);
    assert.equal((await store.history({
      sessionId: original.id,
    })).messages.length, 0);
    assert.equal((await store.list()).length, 1);
  });
}

test('normal execution appends messages without updating any saved transcript row', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-append-only-'));
  const filename = path.join(directory, 'private/state.sqlite');
  const app = await createApplication({
    directory,
  });
  const audit = new DatabaseSync(filename);
  audit.exec(`
    CREATE TABLE rewritten_messages(id TEXT);
    CREATE TRIGGER audit_messages AFTER UPDATE ON records
    WHEN NEW.namespace='conversations' AND json_extract(NEW.data,'$.sequence') >= 0
    BEGIN INSERT INTO rewritten_messages VALUES(NEW.id); END;
  `);
  t.after(async () => {
    audit.close();
    await app.close();
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  });
  let requests = 0;
  app.models.register({
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture',
    contextTokens: 32768,
    outputTokens: 8192,
    backend: {
      id: 'fixture',
      revision: 'fixture-v1',
      async complete() {
        requests++;

        if (requests < 8)
          return {
            model: 'fixture',
            finish: 'tools',
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-' + requests, name: 'observe', arguments: {} }],
            },
          };

        return {
          model: 'fixture',
          finish: 'stop',
          message: { role: 'assistant', content: 'Done' },
        };
      },
    },
  });
  app.tools.register({
    effect: 'read',
    definition: { name: 'observe', description: 'Observe state', parameters: {} },
    async execute() {
      return { content: 'Observed' };
    },
  });
  const created = await app.sessions.create();
  assert.equal(
    (
      await app.sessions.run({
        sessionId: created.sessionId,
        input: 'Observe',
        workspace: directory,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await app.sessions.run({
        sessionId: created.sessionId,
        input: 'Follow up',
        workspace: directory,
      })
    ).ok,
    true,
  );
  const { count } = audit.prepare('SELECT count(*) AS count FROM rewritten_messages').get()!;
  assert.equal(count, 0);
  const session = (await app.sessions.get({
    id: created.sessionId,
  }))!;
  const history = await app.sessions.history({
    sessionId: session.id,
    after: -1,
    limit: 250,
  });
  assert.equal(session.messageCount, history.messages.length);
  assert.equal(history.messages.filter(({ role }) => role === 'tool').length, 7);
  assert.equal(new Set(history.messages.map(({ id }) => id)).size, history.messages.length);
});

test('a failed atomic message batch leaves the header and old transcript intact', async () => {
  const storage = new SqliteStorage({
    filename: ':memory:',
  });
  const records = storage.records<{ id: string; value: number }>('fixture');
  try {
    await records.save({
      id: 'saved',
      value: 1,
    });
    await assert.rejects(
      records.write({
        delete: { id: 'saved' },
        save: [
          { id: 'new', value: 2 },
          { id: undefined as unknown as string, value: 3 },
        ],
      }),
    );
    assert.deepEqual(await records.list(), [{ id: 'saved', value: 1 }]);
  } finally {
    await storage.close();
  }
});

test('a transcript retains opened pages and catches up with a burst larger than one response', async () => {
  const messages = conversation('view').messages;
  const requested: number[] = [];
  const transcript = new Transcript({
    sessionId: 'view',
    async read(query) {
      const { before = messages.length, after, limit = 50 } = query;
      const start = after === undefined ? Math.max(0, before - limit) : after + 1;
      const page: SessionMessage[] = messages.slice(start, Math.min(start + limit, before));
      requested.push(page.length);

      return { messages: structuredClone(page), start, total: messages.length };
    },
  });
  assert.equal((await transcript.refresh()).messages.length, 50);
  assert.equal((await transcript.earlier()).messages.length, 100);
  messages.push(
    ...Array.from(
      {
        length: 123,
      },
      (_, index): SessionMessage => ({
        id: 'new-' + index,
        role: 'assistant',
        content: 'New ' + index,
      }),
    ),
  );
  const updated = await transcript.refresh();
  assert.equal(updated.messages.length, 223);
  assert.equal(updated.start, 1101);
  assert.equal(new Set(updated.messages.map(({ id }) => id)).size, 223);
  assert.ok(requested.every((size) => size <= 50));
});
