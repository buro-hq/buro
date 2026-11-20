import test from 'node:test';
import assert from 'node:assert/strict';
import {
  endpointIsLocal,
  endpointIsPrivate,
  modelEndpointURL,
  type EndpointTrust,
} from '../protocol/endpoint-trust.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { ResourceSelection } from '../core/resource-selection.ts';
import { RuntimeRouter, type RuntimeRoute } from '../core/runtime-router.ts';
import type { AgentRuntime, ProjectRegistry } from '../core/ports.ts';
import type { ModelProvider } from '../core/model-ports.ts';
import type { RuntimeResource } from '../protocol/resources.ts';

test('private-network trust is an explicit assertion limited to private IP literals', () => {
  for (const host of [
    '10.0.0.0',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.50.10',
    '127.0.0.1',
    '127.255.255.255',
    '[::1]',
    '[fc00::]',
    '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
  ]) {
    const url = modelEndpointURL(`http://${host}:11434`);
    assert.equal(endpointIsPrivate(url), true, host);
    assert.equal(endpointIsLocal(url, 'private-network'), true, host);
  }
  for (const host of [
    '9.255.255.255',
    '11.0.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '8.8.8.8',
    '0.0.0.0',
    '169.254.1.1',
    '100.64.0.1',
    '[::]',
    '[fe80::1]',
    '[2001:db8::1]',
    '[::ffff:192.168.50.10]',
    'localhost',
    'rtx.local',
    '192.168.50.10.example.com',
  ]) {
    const url = modelEndpointURL(`http://${host}:11434`);
    assert.equal(endpointIsPrivate(url), false, host);
    assert.throws(() => endpointIsLocal(url, 'private-network'), /literal private/, host);
  }
});

test('auto preserves loopback behavior and external overrides even loopback', () => {
  for (const host of ['localhost', '127.0.0.1', '127.10.1.2', '[::1]']) {
    const url = modelEndpointURL(`http://${host}`);
    assert.equal(endpointIsLocal(url), true, host);
    assert.equal(endpointIsLocal(url, 'external'), false, host);
  }
  for (const host of ['192.168.50.10', '10.0.0.1', '[fd00::1]', 'rtx.local', '8.8.8.8']) {
    const url = modelEndpointURL(`http://${host}`);
    assert.equal(endpointIsLocal(url), false, host);
    assert.equal(endpointIsLocal(url, 'external'), false, host);
  }
});

test('endpoint URL canonicalization retains base paths and rejects credential/query/fragment URLs', () => {
  assert.equal(
    modelEndpointURL('HTTP://192.168.50.10:11434/ollama').href,
    'http://192.168.50.10:11434/ollama/',
  );
  assert.equal(modelEndpointURL('http://[FD00:0000::0001]:11434/').hostname, '[fd00::1]');
  assert.equal(endpointIsPrivate(modelEndpointURL('http://0xc0a800e3:11434')), true);
  for (const endpoint of [
    'not a URL',
    'file:///tmp/model',
    'ftp://192.168.50.10',
    'http://user:private-secret@192.168.50.10',
    'http://@192.168.50.10',
    'http://192.168.50.10/?',
    'http://192.168.50.10/#',
    'http://192.168.50.10/?token=private-secret',
    'http://192.168.50.10/#private-secret',
  ]) {
    assert.throws(
      () => modelEndpointURL(endpoint),
      (error: Error) => {
        assert.doesNotMatch(String(error), /private-secret/);
        return true;
      },
    );
  }
});

test('Ollama endpoint trust contributes to configuration identity without changing auto identity', () => {
  const options = { id: 'rtx', endpoint: 'http://192.168.50.10:11434' };
  const automatic = new OllamaProvider(options);
  const explicitAuto = new OllamaProvider({ ...options, trust: 'auto' });
  const privateNetwork = new OllamaProvider({ ...options, trust: 'private-network' });
  const external = new OllamaProvider({ ...options, trust: 'external' });
  assert.equal(automatic.local, false);
  assert.equal(explicitAuto.revision, automatic.revision);
  assert.equal(privateNetwork.local, true);
  assert.equal(external.local, false);
  assert.equal(new Set([automatic.revision, privateNetwork.revision, external.revision]).size, 3);
  assert.equal(
    new OllamaProvider({ id: 'rtx', endpoint: 'http://localhost:11434', trust: 'external' }).local,
    false,
  );
  assert.throws(
    () =>
      new OllamaProvider({
        id: 'rtx',
        endpoint: 'https://public.example',
        trust: 'private-network',
      }),
    { code: 'INVALID_ENDPOINT' },
  );
});

const input = (model = 'fixture-model'): Parameters<ModelProvider['complete']>[0] => ({
  requestId: 'request',
  model,
  messages: [{ role: 'user', content: 'Return JSON.' }],
  tools: [],
  schema: { type: 'object' },
  contextTokens: 1000,
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  onProgress() {},
});

test('a trusted LAN endpoint never makes cloud-backed Ollama models local or permits their execution', async () => {
  for (const remote of [
    { model: 'fixture-model', metadata: { remote_host: 'https://cloud.example' } },
    { model: 'fixture-model', metadata: { remote_model: 'cloud-model' } },
    { model: 'qwen:cloud', metadata: {} },
    { model: 'qwen-cloud:latest', metadata: {} },
  ]) {
    let calls = 0;
    const provider = new OllamaProvider({
      id: 'rtx',
      endpoint: 'http://192.168.50.10:11434',
      trust: 'private-network',
      fetch: async (url) => {
        calls++;
        assert.equal(new URL(String(url)).pathname, '/api/show');
        return Response.json({ capabilities: ['tools'], ...remote.metadata });
      },
    });
    const inspected = await provider.inspect(remote.model, new AbortController().signal);
    assert.equal(inspected.local, false);
    assert.equal(inspected.remote, true);
    await assert.rejects(provider.complete(input(remote.model)), { code: 'MODEL_REMOTE_ROUTE' });
    assert.equal(calls, 2);
  }
});

test('provider options are a snapshot and the trusted endpoint retains its API base path', async () => {
  const options = {
    id: 'rtx',
    endpoint: 'http://192.168.50.10:11434/ollama',
    trust: 'private-network' as EndpointTrust,
    fetch: async (url: Parameters<typeof fetch>[0]) => {
      assert.equal(String(url), 'http://192.168.50.10:11434/ollama/api/show');
      return Response.json({ capabilities: ['tools'] });
    },
  };
  const provider = new OllamaProvider(options);
  options.endpoint = 'https://unrelated.example';
  options.trust = 'external';
  assert.equal((await provider.inspect('fixture-model', new AbortController().signal)).local, true);
});

test('local-only selection permits explicit LAN trust and frozen sessions reject a changed trust revision', async (t) => {
  const endpoint = 'http://192.168.50.10:11434';
  const resource = (trust: EndpointTrust): RuntimeResource => {
    const provider = new OllamaProvider({ id: 'rtx', endpoint, trust });
    return {
      id: 'rtx-model',
      client: 'managed',
      providerId: 'rtx',
      model: 'qwen',
      local: provider.local,
      configurationRevision: provider.revision,
    };
  };
  const resources = [resource('auto')];
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p', root: '/fixture' }, runs: [] }) }),
  } as unknown as ProjectRegistry;
  const selection = new ResourceSelection({
    projects,
    runtimes: resources,
    defaultProfile: () => 'local',
    profiles: [
      {
        id: 'local',
        name: 'Local',
        policy: 'local-only',
        coordinator: 'rtx-model',
        worker: 'rtx-model',
        reviewer: 'rtx-model',
      },
    ],
  });
  assert.throws(() => selection.forProject('p'), { code: 'DATA_POLICY_BLOCKED' });
  resources[0] = resource('private-network');
  const saved = selection.forProject('p');
  let nativeTurns = 0;
  const runtime = {
    id: 'rtx-model',
    async start() {
      return { threadId: 'native' };
    },
    async turn() {
      nativeTurns++;
      return { turnId: 'turn', text: '{}' };
    },
    async interrupt() {},
    async dispose() {},
  } as AgentRuntime;
  const records = new Map<string, RuntimeRoute>();
  const router = new RuntimeRouter({
    projects,
    selection,
    resources,
    registry: {
      list: () => [],
      get: () => runtime,
      register() {},
      async dispose() {},
    },
    routes: {
      async load(id) {
        return structuredClone(records.get(id));
      },
      async save(route) {
        records.set(route.id, structuredClone(route));
      },
    },
    id: () => 'session',
  });
  t.after(async () => {
    resources[0] = saved.coordinator;
    await router.dispose();
  });
  const session = await router.start({ projectId: 'p', instructions: 'Work' });
  resources[0] = resource('external');
  assert.equal(saved.coordinator.local, true);
  assert.notEqual(saved.coordinator.configurationRevision, resources[0].configurationRevision);
  assert.throws(() => selection.forProject('p'), { code: 'DATA_POLICY_BLOCKED' });
  await assert.rejects(
    router.turn(session.threadId, 'Continue', {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 1000,
    }),
    { code: 'RUNTIME_CONFIG_CHANGED' },
  );
  assert.equal(nativeTurns, 0);
});
