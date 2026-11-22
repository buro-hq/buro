import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../plugins/host.ts';
import { websocketPlugin } from '../daemon/websocket.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
import { effectiveProjectPolicy } from '../core/autonomy-policy.ts';

test(
  'a revision seen before reconnect cannot suppress a later return to that configuration',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-reconnect-hash-review-'));
    const host = await createHost({
      projects: [
        {
          storageAddress: path.join(directory, 'project'),
          project: { id: 'p', name: 'P', root: directory },
        },
      ],
    });
    const client = new SocketProjectClient();
    t.after(async () => {
      client.close();
      await host.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    });
    let revision = 1;
    host.ctx.on('project/snapshot', (snapshot) => {
      snapshot.effectivePolicy = effectiveProjectPolicy({
        policy: {
          scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
          checks: [],
          defaultCheckIds: [],
          maxWorkers: 1,
        },
      });
      snapshot.effectivePolicy.origin.revision = revision;
    });
    let port = 0;
    await host.ctx.plugin(websocketPlugin, {
      port: 0,
      onListen: (value) => {
        port = value;
      },
    });
    client.url = `ws://127.0.0.1:${port}`;
    client.projectId = 'p';
    const changed = (expected: number) =>
      new Promise<void>((resolve) => {
        if (client.state?.effectivePolicy?.origin.revision === expected) return resolve();
        const unsubscribe = client.onChange((snapshot) => {
          if (snapshot.effectivePolicy?.origin.revision === expected) {
            unsubscribe();
            resolve();
          }
        });
      });
    const emit = () =>
      host.ctx.emit('service/change', {
        topic: 'resources',
        revision: 'a'.repeat(64),
        appliesTo: 'new-runs',
      });
    await client.connect();
    revision = 2;
    const first = changed(2);
    emit();
    await first;
    assert.equal(client.getResourceRevision(), 'a'.repeat(64));
    const beforeReconnect = client.getResourceGeneration();
    const reconnected = new Promise<void>((resolve) => {
      const unsubscribe = client.onConnection((state) => {
        if (state === 'connected' && client.getResourceGeneration() > beforeReconnect) {
          unsubscribe();
          resolve();
        }
      });
    });
    // Another configuration takes effect while disconnected; its notification is missed.
    client.ws!.close();
    revision = 3;
    await reconnected;
    assert.equal(client.snapshot().effectivePolicy?.origin.revision, 3);
    const baseline = client.getResourceGeneration();
    revision = 4;
    const restored = changed(4);
    // The user returns to configuration A. Its hash equals the pre-disconnect event.
    emit();
    await client.command({ method: 'service.info', params: {} });
    assert.equal(client.getResourceGeneration(), baseline + 1);
    await restored;
    assert.equal(client.snapshot().effectivePolicy?.origin.revision, 4);
    assert.equal(client.snapshot().sequence, 0);
  },
);
