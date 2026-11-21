import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityProbeService,
  type ProbeReceipt,
  type ProbeResult,
  type ProbeStore,
} from '../core/capability-probe.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';

class MemoryProbes implements ProbeStore {
  requests = new Map<string, ProbeReceipt>();
  results = new Map<string, ProbeResult>();
  async loadRequest(id: string) {
    return structuredClone(this.requests.get(id));
  }
  async saveRequest(receipt: ProbeReceipt) {
    this.requests.set(receipt.id, structuredClone(receipt));
  }
  async saveResult(result: ProbeResult) {
    this.results.set(result.runtimeId, structuredClone(result));
  }
}
function fixture(complete?: ModelProvider['complete']) {
  const store = new MemoryProbes();
  let requests = 0,
    ids = 0;
  const provider: ModelProvider = {
    id: 'p',
    revision: 'v1',
    local: true,
    complete: async (input) => {
      requests++;
      if (complete) return complete(input);
      assert.equal(store.requests.get('command')?.status, 'started');
      if (requests === 1) {
        assert.equal(input.schema, undefined);
        assert.equal(input.tools.length, 1);
        assert.equal(input.messages.length, 1);
        assert.match(input.messages[0].content, /diagnostic_echo exactly once/);
        assert.doesNotMatch(input.messages[0].content, /JSON|"ok"/);
        return {
          model: 'model-reported',
          finish: 'tools',
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'echo',
                name: 'diagnostic_echo',
                arguments: { value: 'buro-ready' },
              },
            ],
            continuation: { private: 'PRIVATE_REASONING' },
          },
        };
      }
      assert.match(JSON.stringify(input.messages), /PRIVATE_REASONING/);
      assert.deepEqual(input.tools, []);
      assert.equal(input.messages.at(-2)?.role, 'tool');
      assert.equal(input.messages.at(-1)?.role, 'user');
      assert.match(input.messages.at(-1)!.content, /Return only JSON/);
      assert.deepEqual(input.schema, {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      });
      return {
        model: 'model-reported',
        finish: 'stop',
        message: { role: 'assistant', content: '{"ok":true}' },
      };
    },
  };
  const make = () =>
    new CapabilityProbeService({
      store,
      now: () => '2026-11-20T00:00:00Z',
      id: () => String(++ids),
      binding: () => ({
        provider,
        model: 'model-requested',
        configurationRevision: 'v1',
        contextTokens: 16000,
        maxOutputTokens: 1024,
      }),
    });
  return { store, make, requests: () => requests };
}

test('capability probes persist intent, share replayed work and return saved evidence after restart', async () => {
  const f = fixture(),
    service = f.make();
  const first = service.probe('command', 'fingerprint', 'runtime');
  assert.equal(service.probe('command', 'fingerprint', 'runtime'), first);
  const result = await first;
  assert.equal(result.status, 'passed');
  assert.equal(result.reportedModel, 'model-reported');
  assert.equal(f.requests(), 2);
  assert.doesNotMatch(
    JSON.stringify([...f.store.results.values(), ...f.store.requests.values()]),
    /PRIVATE_REASONING/,
  );
  await service.dispose();
  const restarted = f.make();
  assert.deepEqual(await restarted.probe('command', 'fingerprint', 'runtime'), result);
  assert.equal(f.requests(), 2);
  await assert.rejects(restarted.probe('command', 'different', 'runtime'), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await restarted.dispose();
});

test('a probe with an unknown prior outcome is never repeated', async () => {
  const f = fixture();
  await f.store.saveRequest({
    id: 'command',
    fingerprint: 'fingerprint',
    runtimeId: 'runtime',
    status: 'started',
  });
  const service = f.make();
  await assert.rejects(service.probe('command', 'fingerprint', 'runtime'), {
    code: 'PROBE_INTERRUPTED',
  });
  assert.equal(f.requests(), 0);
  await service.dispose();
});

test('failed intent persistence prevents model calls, while invalid tool support stores a failure receipt', async () => {
  const f = fixture();
  f.store.saveRequest = async () => {
    throw Error('disk unavailable');
  };
  const service = f.make();
  await assert.rejects(service.probe('command', 'fingerprint', 'runtime'), /disk unavailable/);
  assert.equal(f.requests(), 0);
  await service.dispose();
  const bad = fixture(async () => ({
    model: 'm',
    finish: 'stop',
    message: { role: 'assistant', content: '{"ok":true}' },
  }));
  const badService = bad.make();
  await assert.rejects(badService.probe('command', 'fingerprint', 'runtime'), {
    code: 'MODEL_CAPABILITY_FAILED',
  });
  await assert.rejects(badService.probe('command', 'fingerprint', 'runtime'), {
    code: 'MODEL_CAPABILITY_FAILED',
  });
  assert.equal(bad.requests(), 1);
  await badService.dispose();
});

test('service disposal aborts model inference and preserves a retry-safe interrupted receipt', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(async ({ signal }) => {
    entered();
    await new Promise((_, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Interrupted', 'AbortError')),
        { once: true },
      ),
    );
    throw Error('Unreachable');
  });
  const service = f.make();
  const done = service.probe('command', 'fingerprint', 'runtime');
  const rejected = assert.rejects(done, { code: 'PROBE_INTERRUPTED' });
  await ready;
  await service.dispose();
  await rejected;
  assert.equal(f.store.requests.get('command')?.status, 'failed');
  assert.equal(f.requests(), 1);
});

test('separated probe instructions still reject duplicate calls and truncated or malformed terminal answers', async () => {
  const first = {
    model: 'm',
    finish: 'tools' as const,
    message: {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        {
          id: 'echo',
          name: 'diagnostic_echo',
          arguments: { value: 'buro-ready' },
        },
      ],
    },
  };
  const final = {
    model: 'm',
    finish: 'stop' as const,
    message: { role: 'assistant' as const, content: '{"ok":true}' },
  };
  const invalid = [
    {
      first: {
        ...first,
        message: {
          ...first.message,
          toolCalls: [
            first.message.toolCalls[0],
            { ...first.message.toolCalls[0], id: 'duplicate' },
          ],
        },
      },
    },
    { first: { ...first, finish: 'length' as const } },
    { final: { ...final, message: { ...final.message, content: '{"ok":' } } },
    { final: { ...final, finish: 'length' as const } },
    {
      final: {
        ...final,
        message: { ...final.message, toolCalls: first.message.toolCalls },
      },
    },
  ];
  for (const fault of invalid) {
    let requests = 0;
    const f = fixture(async () => (++requests === 1 ? fault.first || first : fault.final || final));
    const service = f.make();
    await assert.rejects(service.probe('command', 'fingerprint', 'runtime'), {
      code: 'MODEL_CAPABILITY_FAILED',
    });
    assert.equal(requests, fault.first ? 1 : 2);
    assert.equal(f.store.results.size, 0);
    assert.equal(f.store.requests.get('command')?.status, 'failed');
    await service.dispose();
  }
});
