import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentLoopFailure, isAgentLoopFailure } from '../agent/contracts/loop-errors.ts';

const execute = promisify(execFile);

test('an independent host consumes loop contracts without application, SDK or Node types', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'contracts'));
  for (const file of ['loop.ts', 'loop-errors.ts', 'model.ts'])
    await fs.copyFile(
      path.resolve('agent/contracts', file),
      path.join(directory, 'contracts', file),
    );
  await fs.writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: [],
        erasableSyntaxOnly: true,
      },
      include: ['**/*.ts'],
    }),
  );
  await fs.writeFile(
    path.join(directory, 'consumer.ts'),
    `import type { AgentLoopHost, AgentLoopRunner, AgentLoopRequest, AgentLoopBatch, AgentLoopDecision } from './contracts/loop.ts';
import type { ModelCompletion, ModelProvider } from './contracts/model.ts';
import { AgentLoopFailure } from './contracts/loop-errors.ts';

// Neither a budget service nor an SDK message or application scope is required.
declare const runner: AgentLoopRunner;
declare const request: AgentLoopRequest;
declare const batch: AgentLoopBatch;
declare const signal: AbortSignal;
declare const savedCompletion: Awaited<ReturnType<ModelProvider['complete']>>;
const completion: ModelCompletion = savedCompletion;
const host: AgentLoopHost = {
  async prepare() { return request; },
  async generate(requestId) {
    const opaqueId: string = requestId;
    return { ...batch, response: completion };
  },
  async execute(batchId, actionId) {
    const savedIds: string[] = [batchId, actionId];
    return { content: savedIds.join('/'), isError: false };
  },
  async advance(batchId) {
    const decision: AgentLoopDecision = batchId ? { kind: 'yield' } : { kind: 'complete' };
    return decision;
  },
};
async function invoke() {
  const result = await runner.run(host, signal);
  const terminal: 'yield' | 'complete' = result.kind;
  const provider: string = request.model.providerId;
  const response: ModelCompletion = batch.response;
  // The scheduler cannot pass replacement model arguments to the effect authority.
  // @ts-expect-error execute accepts saved IDs only
  await host.execute(batch.id, batch.actions[0].id, { arguments: { path: 'changed' } });
  // @ts-expect-error a scheduler result cannot assert application acceptance
  const accepted: boolean = result.accepted;
  // @ts-expect-error a scheduling request does not carry application policy
  const scope = request.writeScope;
  const internalFailure = new AgentLoopFailure({ privateSDKPayload: true });
  const stableCode: 'AGENT_LOOP_FAILED' = internalFailure.code;
  // @ts-expect-error internal faults cannot supply a public message or a host outcome
  new AgentLoopFailure('public payload', { outcome: 'rejected' });
}
`,
  );
  const result = await execute(
    process.execPath,
    [
      path.resolve('node_modules/typescript/bin/tsc'),
      '--project',
      path.join(directory, 'tsconfig.json'),
      '--pretty',
      'false',
    ],
    { cwd: directory },
  );
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('scheduler faults expose a fixed failure without leaking private SDK payload or claiming an outcome', () => {
  const cause = new Error('PRIVATE_SDK_TOOL_ARGUMENTS');
  const failure = new AgentLoopFailure(cause);
  assert.equal(failure.code, 'AGENT_LOOP_FAILED');
  assert.equal(failure.message, 'The agent scheduler stopped before completion.');
  assert.equal(failure.cause, cause);
  assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_SDK_TOOL_ARGUMENTS/);
  assert.doesNotMatch(String(failure), /PRIVATE_SDK_TOOL_ARGUMENTS/);
  assert.equal('outcome' in failure, false);
  assert.equal('accepted' in failure, false);
  assert.throws(() => {
    (failure as { code: string }).code = 'HOST_FAILURE';
  }, TypeError);
  assert.equal(isAgentLoopFailure(failure), true);
  for (const value of [
    cause,
    new Error('Host failure', { cause: failure }),
    { name: 'AgentLoopFailure', code: 'AGENT_LOOP_FAILED' },
    null,
  ])
    assert.equal(isAgentLoopFailure(value), false);
});
