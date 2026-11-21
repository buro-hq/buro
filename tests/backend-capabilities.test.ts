import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendCapabilities } from '../agent/contracts/capabilities.ts';
import {
  BackendCapabilitiesSchema,
  BackendRequirementsSchema,
} from '../protocol/backend-capabilities.ts';
import {
  assertBackendAdmission,
  freezeBackendCapabilities,
  requireBackendCapabilities,
} from '../core/backend-capabilities.ts';
import type { RegisteredRuntime } from '../core/ports.ts';
import { RuntimeCatalog } from '../core/runtimes.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';

function backend(id: string, capabilities = fixtureCapabilities()): RegisteredRuntime {
  return {
    id,
    capabilities,
    async start() {
      return { threadId: 'session' };
    },
    async submit() {
      return { turnId: 'turn' };
    },
    async interrupt() {},
    async dispose() {},
  };
}

test('backend descriptors require explicit complete mechanics without brand or defaults', () => {
  const valid = fixtureCapabilities();
  assert.deepEqual(BackendCapabilitiesSchema.parse(valid), valid);
  for (const key of Object.keys(valid)) {
    const incomplete = { ...valid } as Record<string, unknown>;
    delete incomplete[key];
    assert.equal(BackendCapabilitiesSchema.safeParse(incomplete).success, false, key);
  }
  for (const invalid of [
    { ...valid, backend: 'managed' },
    { ...valid, version: 2 },
    { ...valid, revision: '' },
    { ...valid, revision: 'mutable revision' },
    { ...valid, toolsFreeTurns: true },
    { ...valid, immutableReview: true },
    { ...valid, cancellation: 'best-effort' },
    { ...valid, usage: 'estimated' },
  ]) {
    assert.throws(() => freezeBackendCapabilities(invalid), {
      code: 'INVALID_BACKEND_CAPABILITIES',
    });
  }
});

test('requirements cannot disable safety with false values or invent unknown authority', () => {
  assert.deepEqual(BackendRequirementsSchema.parse({}), {});
  for (const requirements of [
    { readOnlySessions: false },
    { model: 'smart' },
    { usage: 'unknown' },
  ]) {
    assert.equal(BackendRequirementsSchema.safeParse(requirements).success, false);
    assert.throws(() => requireBackendCapabilities(fixtureCapabilities(), requirements as never), {
      code: 'INVALID_BACKEND_REQUIREMENTS',
    });
  }
});

test('catalog freezes a private capability snapshot and retains bound adapter behavior', async () => {
  const declaration = { ...fixtureCapabilities() };
  const adapter = {
    ...backend('arbitrary-client', declaration),
    submissions: 0,
    async submit() {
      this.submissions++;
      return { turnId: String(this.submissions) };
    },
  };
  const catalog = new RuntimeCatalog();
  catalog.register(adapter);
  const registered = catalog.get(adapter.id);
  assert.notEqual(registered, adapter);
  assert.notEqual(registered.capabilities, declaration);
  assert.equal(Object.isFrozen(registered), true);
  assert.equal(Object.isFrozen(registered.capabilities), true);
  declaration.readOnlySessions = true;
  declaration.revision = 'later';
  adapter.capabilities = fixtureCapabilities({ usage: 'reported' });
  assert.equal(registered.capabilities.readOnlySessions, false);
  assert.equal(registered.capabilities.revision, 'fixture-v1');
  assert.equal(registered.capabilities.usage, 'unknown');
  assert.throws(() => {
    (registered.capabilities as { readOnlySessions: boolean }).readOnlySessions = true;
  }, TypeError);
  assert.throws(() => {
    (registered as { capabilities: BackendCapabilities }).capabilities = declaration;
  }, TypeError);
  assert.deepEqual(await registered.submit('session', 'first'), { turnId: '1' });
  assert.deepEqual(await registered.submit('session', 'second'), { turnId: '2' });
  assert.equal(adapter.submissions, 2);
  await catalog.dispose();
});

test('catalog rejects missing declared methods before starting any backend', () => {
  const catalog = new RuntimeCatalog();
  let starts = 0;
  for (const requirement of [{ structuredTurns: true }, { resumeSessions: true }]) {
    const adapter = backend('unavailable', fixtureCapabilities(requirement));
    adapter.start = async () => {
      starts++;
      return { threadId: 'unexpected' };
    };
    assert.throws(() => catalog.register(adapter), { code: 'INVALID_BACKEND_CAPABILITIES' });
  }
  assert.deepEqual(catalog.list(), []);
  assert.equal(starts, 0);
});

test('saved capability identity cannot silently change, disappear or select another adapter', async () => {
  const catalog = new RuntimeCatalog();
  catalog.register(backend('codex'));
  const registered = catalog.get('codex');
  const caps = registered.capabilities;
  const failures = [
    { id: 'codex', capabilities: undefined },
    { id: 'codex', capabilities: { ...caps, revision: 'new-implementation' } },
    { id: 'codex', capabilities: { ...caps, readOnlySessions: true } },
  ];
  for (const resource of failures)
    assert.throws(() => assertBackendAdmission(resource, registered), {
      code: 'BACKEND_CAPABILITIES_CHANGED',
    });
  assert.throws(() => assertBackendAdmission({ id: 'managed', capabilities: caps }, registered), {
    code: 'RUNTIME_CONFIG_CHANGED',
  });
  // Persisted object member order is not backend identity.
  const reordered = Object.fromEntries(Object.entries(caps).reverse()) as BackendCapabilities;
  assert.doesNotThrow(() =>
    assertBackendAdmission({ id: 'codex', capabilities: reordered }, registered),
  );
  await catalog.dispose();
});

test('methods and recognizable client IDs do not imply supported assignment mechanics', async () => {
  const catalog = new RuntimeCatalog();
  let dispatched = 0;
  catalog.register({
    ...backend('managed'),
    async turn() {
      dispatched++;
      return { turnId: 'unexpected', text: '' };
    },
  });
  const registered = catalog.get('managed');
  const saved = { id: registered.id, capabilities: registered.capabilities };
  for (const requirements of [
    { structuredTurns: true as const },
    { toolsFreeTurns: true as const },
    { readOnlySessions: true as const },
    { immutableReview: true as const },
    { strictPlannedWrites: true as const },
    { hostToolLifecycle: true as const },
    { usage: 'reported' as const },
    { resumeSessions: true as const },
    { cancellation: 'settled-or-unknown' as const },
  ])
    assert.throws(() => assertBackendAdmission(saved, registered, requirements), {
      code: 'BACKEND_CAPABILITY_UNAVAILABLE',
    });
  assert.equal(dispatched, 0);
  await catalog.dispose();
});

test('admission accepts explicitly supported mechanics for a backend with an arbitrary name', async () => {
  const catalog = new RuntimeCatalog();
  const caps = fixtureCapabilities({
    structuredTurns: true,
    toolsFreeTurns: true,
    readOnlySessions: true,
    immutableReview: true,
    hostToolLifecycle: true,
    resumeSessions: true,
    usage: 'reported',
    cancellation: 'settled-or-unknown',
  });
  let dispatched = 0;
  catalog.register({
    ...backend('custom-plugin-vendor', caps),
    async turn() {
      dispatched++;
      return { turnId: 'turn', text: '' };
    },
    async resume() {
      dispatched++;
      return { threadId: 'resumed' };
    },
  });
  const registered = catalog.get('custom-plugin-vendor');
  assert.doesNotThrow(() =>
    assertBackendAdmission({ id: registered.id, capabilities: caps }, registered, {
      structuredTurns: true,
      toolsFreeTurns: true,
      readOnlySessions: true,
      immutableReview: true,
      hostToolLifecycle: true,
      resumeSessions: true,
      usage: 'reported',
      cancellation: 'settled-or-unknown',
    }),
  );
  assert.throws(
    () =>
      assertBackendAdmission({ id: registered.id, capabilities: caps }, registered, {
        strictPlannedWrites: true,
      }),
    { code: 'BACKEND_CAPABILITY_UNAVAILABLE' },
  );
  assert.equal(dispatched, 0);
  await catalog.dispose();
});
