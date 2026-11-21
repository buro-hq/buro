const { z } = require('zod');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { confinedOutput, inspectScope } = require('./model-comparison.cjs');
const { SAFE_JSON_SOURCE } = require('./oracle-serialization.cjs');

const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const priority = z.number().int().min(-10000).max(10000).nullable().optional();
const task = z.strictObject({ id, priority, dependsOn: z.array(id).max(8).optional() });
const probe = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('priority'), task: z.strictObject({ priority }) }),
  z.strictObject({
    kind: z.literal('ready'),
    tasks: z.array(task).max(8),
    done: z.array(id).max(16),
  }),
]);
const proposal = z.strictObject({ cases: z.array(probe).min(1).max(5) });
const PROBE_SCHEMA = z.toJSONSchema(proposal);
function validateProbes(value) {
  const parsed = proposal.safeParse(value);
  if (!parsed.success)
    throw Object.assign(Error('Invalid declarative probes.'), {
      code: 'INVALID_EXPERIMENT_PROBES',
    });
  return parsed.data.cases;
}

// A model proposes inputs. Expectations come exclusively from the fixed fixture
// requirements, so a test author cannot redefine correctness or submit code.
function expectedFor(input) {
  if (input.kind === 'priority') return input.task.priority ?? 2;
  const done = new Set(input.done);
  return input.tasks
    .map((value, index) => ({ value, index }))
    .filter(
      ({ value }) =>
        !done.has(value.id) && (value.dependsOn || []).every((dependency) => done.has(dependency)),
    )
    .sort((a, b) => (b.value.priority ?? 2) - (a.value.priority ?? 2) || a.index - b.index)
    .map(({ value }) => value.id);
}

const CHILD = `
import { readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
${SAFE_JSON_SOURCE}
const parse = JSON.parse.bind(JSON);
const freeze = Object.freeze;
const values = Object.values;
const map = Function.call.bind(Array.prototype.map);
const isArray = Array.isArray;
const request = parse(readFileSync(0, 'utf8'));
const freezeInput = value => {
  if (value && typeof value === 'object') { map(values(value), freezeInput); freeze(value); }
};
freezeInput(request.inputs);
const emit = writeSync.bind(null, 1);
const root = process.argv[1];
const { priorityOf } = await import(pathToFileURL(path.join(root, 'src/priority.mjs')));
const { selectReady } = await import(pathToFileURL(path.join(root, 'src/queue.mjs')));
const outputs = map(request.inputs, input => {
  const before = stringify(input);
  let value;
  if (input.kind === 'priority') value = priorityOf(input.task);
  else {
    const selected = selectReady(input.tasks, input.done);
    if (!isArray(selected)) throw Error('Expected task array');
    value = map(selected, task => task.id);
  }
  return { value, unchanged: stringify(input) === before };
});
emit(stringify({ nonce: request.nonce, outputs }));
`;

async function runGeneratedProbes(fixture, workspace, cases, options = {}) {
  const inputs = validateProbes({ cases });
  options.signal?.throwIfAborted();
  const before = await inspectScope(workspace);
  if (!before.passed)
    return {
      passed: false,
      checks: inputs.length,
      passedChecks: 0,
      rows: [],
      scope: before,
      sourceHash: before.sourceHash,
    };
  const { EnvironmentExecutors } = await import('../../adapters/environments/executors.ts');
  const executors = new EnvironmentExecutors();
  await executors.register(
    workspace,
    fixture.root,
    { provider: 'native' },
    options.signal || new AbortController().signal,
    { privateDataIsolation: true },
  );
  const launch = executors.launch(
    workspace,
    [process.execPath, '--input-type=module', '-e', CHILD, workspace],
    { readOnly: true, privateDataIsolation: true, allowNetwork: false },
  );
  const nonce = randomUUID();
  let rows;
  try {
    const output = await (options.execute || confinedOutput)(
      launch,
      { nonce, inputs },
      { signal: options.signal, timeoutMs: 10000 },
    );
    const reply = JSON.parse(output);
    if (
      !reply ||
      reply.nonce !== nonce ||
      !Array.isArray(reply.outputs) ||
      reply.outputs.length !== inputs.length
    )
      throw Error('Invalid oracle envelope');
    rows = inputs.map((input, index) => ({
      index,
      passed:
        reply.outputs[index]?.unchanged === true &&
        isDeepStrictEqual(reply.outputs[index]?.value, expectedFor(input)),
    }));
  } catch {
    options.signal?.throwIfAborted();
    rows = inputs.map((_, index) => ({ index, passed: false }));
  }
  const after = await inspectScope(workspace);
  const passedChecks = rows.filter((row) => row.passed).length;
  return {
    passed:
      passedChecks === inputs.length && after.passed && before.sourceHash === after.sourceHash,
    checks: inputs.length,
    passedChecks,
    rows,
    scope: after,
    sourceHash: after.sourceHash,
  };
}

module.exports = { PROBE_SCHEMA, validateProbes, expectedFor, runGeneratedProbes };
