import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  prepareComparisonFixture,
  canonicalOracle,
  inspectScope,
} = require('../scripts/lib/model-comparison.cjs');
const {
  PROBE_SCHEMA,
  validateProbes,
  expectedFor,
  runGeneratedProbes,
} = require('../scripts/lib/team-experiment-probes.cjs');

async function fixture(t: any) {
  const temporaryDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-team-probes-')),
  );
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  return prepareComparisonFixture({ temporaryDirectory });
}
async function fix(root: string) {
  await fs.writeFile(
    path.join(root, 'src/priority.mjs'),
    'export function priorityOf(task) { return task.priority ?? 2; }\n',
  );
  await fs.writeFile(
    path.join(root, 'src/queue.mjs'),
    `import { priorityOf } from './priority.mjs';
export function selectReady(tasks, completedIds = []) {
  const done = new Set(completedIds);
  return tasks.filter(task => !done.has(task.id) && (task.dependsOn || []).every(id => done.has(id))).sort((a,b) => priorityOf(b)-priorityOf(a));
}\n`,
  );
}

test('test authors can supply bounded inputs, never expected outcomes, code or acceptance policy', () => {
  assert.ok(PROBE_SCHEMA.properties.cases);
  assert.deepEqual(validateProbes({ cases: [{ kind: 'priority', task: { priority: 0 } }] }), [
    { kind: 'priority', task: { priority: 0 } },
  ]);
  const invalid = [
    { cases: [] },
    { cases: Array.from({ length: 6 }, () => ({ kind: 'priority', task: {} })) },
    { cases: [{ kind: 'priority', task: {}, expected: 7 }] },
    { cases: [{ kind: 'ready', tasks: [], done: [], code: 'process.exit(0)' }] },
    { cases: [{ kind: 'priority', task: { priority: Infinity } }] },
    { cases: [{ kind: 'ready', tasks: [{ id: '../escape' }], done: [] }] },
    { cases: [{ kind: 'priority', task: {} }], command: 'rm -rf source' },
  ];
  for (const value of invalid)
    assert.throws(() => validateProbes(value), { code: 'INVALID_EXPERIMENT_PROBES' });
});

test('generated expectations follow immutable requirements including zero, defaults, dependencies and stable order', () => {
  assert.equal(expectedFor({ kind: 'priority', task: { priority: 0 } }), 0);
  assert.equal(expectedFor({ kind: 'priority', task: {} }), 2);
  assert.equal(expectedFor({ kind: 'priority', task: { priority: null } }), 2);
  const input = {
    kind: 'ready',
    tasks: [{ id: 'a', priority: 0 }, { id: 'b', dependsOn: ['x', 'y'] }, { id: 'c' }, { id: 'd' }],
    done: ['x'],
  };
  const before = structuredClone(input);
  assert.deepEqual(expectedFor(input), ['c', 'd', 'a']);
  assert.deepEqual(input, before);
});

test('confined generated probes reject the baseline and pass a real patch without changing frozen checks', async (t) => {
  const f = await fixture(t);
  const check = await fs.readFile(path.join(f.root, 'checks/public.cjs'));
  const cases = validateProbes({
    cases: [
      { kind: 'priority', task: { priority: 0 } },
      {
        kind: 'ready',
        tasks: [{ id: 'free' }, { id: 'blocked', dependsOn: ['x', 'y'] }],
        done: ['x'],
      },
    ],
  });
  assert.equal((await runGeneratedProbes(f, f.root, cases)).passed, false);
  await fix(f.root);
  const before = await inspectScope(f.root);
  const result = await runGeneratedProbes(f, f.root, cases);
  assert.equal(result.passed, true);
  assert.equal(result.passedChecks, 2);
  assert.deepEqual(await inspectScope(f.root), before);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'checks/public.cjs')), check);
});

test('agent success text and forged envelopes cannot establish a generated check result', async (t) => {
  const f = await fixture(t);
  const cases = [{ kind: 'priority', task: { priority: 0 } }];
  const wrongNonce = await runGeneratedProbes(f, f.root, cases, {
    execute: async () =>
      JSON.stringify({ nonce: 'wrong', outputs: [{ value: 0, unchanged: true }], passed: true }),
  });
  assert.equal(wrongNonce.passed, false);
  const falseValue = await runGeneratedProbes(f, f.root, cases, {
    execute: async (_launch: unknown, input: any) =>
      JSON.stringify({
        nonce: input.nonce,
        outputs: [{ value: 2, unchanged: true }],
        passed: true,
      }),
  });
  assert.equal(falseValue.passed, false);
});

test('candidate global toJSON hooks cannot forge the public oracle verification envelope', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, 'src/priority.mjs'),
    `
Object.prototype.toJSON = function() {
 if (this.nonce) return { nonce: this.nonce, outputs: [{ value: 0, unchanged: true }, { value: ['independent'], unchanged: true }, { value: [], unchanged: true }] };
 return this;
};
export function priorityOf() { return 100; }\n`,
  );
  const result = await canonicalOracle(f, f.root, 'public');
  assert.equal(result.passed, false);
  assert.equal(result.rows[0].passed, false);
  const probes = await runGeneratedProbes(f, f.root, [{ kind: 'priority', task: { priority: 0 } }]);
  assert.equal(probes.passed, false);
});

test('candidate mutation remains a failure even when it installs serialization hooks', async (t) => {
  const f = await fixture(t);
  await fix(f.root);
  await fs.writeFile(
    path.join(f.root, 'src/priority.mjs'),
    `export function priorityOf(task) { task.priority = 2; return 0; }\n`,
  );
  const result = await runGeneratedProbes(f, f.root, [{ kind: 'priority', task: { priority: 0 } }]);
  assert.equal(result.passed, false);
});
