import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { fixtureCapabilities } from './fixtures/backend-capabilities.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { planningTurn, selectPlanningPolicy } from '../core/planning-policy.ts';
import { conservativeRequestPolicy } from '../core/request-policy.ts';
import { resolveTeam } from '../core/execution-ports.ts';
import { TeamPlanSchema, teamOutputSchema } from '../protocol/execution.ts';
import type { ModelProvider } from '../agent/contracts/model.ts';
import type { ProjectRegistry } from '../core/ports.ts';

const instructions =
  'You coordinate a scoped repository change. Preserve the complete user goal, acceptance criteria, fixed model preferences and path restrictions. Planning produces a formal proposal; implementation begins only after service validation. A passing public check alone never substitutes for independent review. Keep uncertainty explicit and do not invent file contents, repository findings or completed checks.';
const planningPolicy = selectPlanningPolicy({
  id: 'fixture-planner',
  backendId: 'managed',
  local: true,
  configurationRevision: 'fixture-v1',
  capabilities: fixtureCapabilities({ structuredTurns: true, toolsFreeTurns: true }),
});
const source = () => ({
  policy: planningPolicy,
  title: 'Preserve synchronous session writes during a failed replacement',
  goalText: [
    'GOAL_SESSION_ATOMICITY: Make the existing synchronous session writer preserve the previous session when a replacement fails.',
    'Keep saveSession and loadSession synchronous, with their existing parameters and return values. Callers must not need await, a new package, configuration changes or a migration.',
    'Write replacement bytes to a uniquely named sibling temporary file. Complete the write and close its descriptor before attempting the atomic rename. Do not remove or truncate the previous destination first.',
    'When rename fails, retain the exact original bytes and propagate the original error. Remove only the temporary file created by this invocation; do not delete unrelated files or mask the original failure with cleanup errors.',
    'Two consecutive writes must use distinct temporary names. A successful write replaces the destination with the complete new session. Existing reads must retain their current missing-file and malformed-data behavior.',
    'Preserve the public exports, module format and supported runtime. Keep the change focused on the session module and its existing shared types; do not rewrite unrelated storage, UI or application code.',
    'Acceptance requires successful replacement, failed-rename preservation, temporary-file cleanup and synchronous compatibility. The service owns the checks and independent review. Do not edit check scripts to make a result pass.',
  ].join('\n'),
  scope: {
    mode: 'strict',
    plannedPaths: ['src/session.ts', 'src/session-types.ts'],
    protectedPaths: ['checks/', 'AGENTS.md', 'package.json', 'package-lock.json'],
  },
  projectContext:
    'The project is an offline desktop utility. Session files may already exist and contain user data; compatibility and preserving the last complete write take priority over introducing abstractions. Use only the existing runtime filesystem API.',
  maxWorkers: 2,
  roles: [
    {
      id: 'builder',
      version: 3,
      title: 'Builder',
      description: 'Implements scoped changes and preserves existing contracts.',
      instructions: 'Implement a focused change and document uncertainty.',
      kind: 'implementation' as const,
      runtimePreference: { mode: 'fixed' as const, runtimeId: 'local-qwen' },
      createdAt: 'now',
      updatedAt: 'now',
    },
  ],
  pool: [
    {
      capabilities: fixtureCapabilities(),
      id: 'local-qwen',
      backendId: 'managed' as const,
      providerId: 'ollama',
      model: 'qwen3:4b',
      local: true,
      configurationRevision: 'frozen',
    },
  ],
  baseline: {
    passed: 0,
    total: 1,
    results: [
      {
        name: 'Session replacement',
        passed: false,
        exitCode: 1,
        output:
          'Expected original bytes after the replacement operation fails; destination contains an incomplete write.',
      },
    ],
  },
  sessionInstructions: instructions,
});

// A completed but verbose first proposal is real context: neither its text nor the
// original brief may be truncated merely to make a subsequent correction fit.
const narrative =
  'Preserve the synchronous session contract, retain old bytes after failed rename, use a unique sibling temporary file, close descriptors, remove only owned temporary artifacts and keep independent acceptance checks unchanged. ';
const invalidPlan = JSON.stringify({
  summary: narrative.repeat(25).slice(0, 5100),
  steps: [
    { step: 'Implement atomic session replacement and failure cleanup.', owner: 'Builder' },
    { step: 'Independently review compatibility and preservation evidence.', owner: 'reviewer' },
  ],
  team: [],
});
const correctedPlan = JSON.stringify({
  summary: 'Make the focused session change without workers, then independently review it.',
  steps: [
    {
      step: 'Implement the complete atomic session goal within the allowed files.',
      owner: 'coordinator',
    },
    { step: 'Review the change and the service-owned acceptance results.', owner: 'reviewer' },
  ],
  team: [],
});

function correction() {
  const input = source();
  try {
    resolveTeam(
      TeamPlanSchema.parse(JSON.parse(invalidPlan)),
      input.roles,
      {
        scope: structuredClone(input.scope),
        maxWorkers: 2,
      } as Parameters<typeof resolveTeam>[2],
      'now',
    );
  } catch (error) {
    return (error as Error).message;
  }
  throw Error('The fixture must require a formal plan correction.');
}

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-planning-correction-')),
  );
  const sessions = new FileManagedSessions(directory);
  const requests: Parameters<ModelProvider['complete']>[0][] = [];
  const decisions: ReturnType<typeof conservativeRequestPolicy.prepare>[] = [];
  const grants: number[] = [];
  let toolsReserved = 0,
    effects = 0,
    nextId = 0;
  const runtime = new ManagedAgentRuntime({
    loopRunner: new PiAgentLoopRunner(),
    id: 'managed-fixture',
    model: 'qwen3:4b',
    sessions,
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', root: directory },
          runs: [{ id: 'R-fixture', workspace: directory }],
        }),
      }),
    } as unknown as ProjectRegistry,
    provider: {
      id: 'ollama-fixture',
      revision: '1',
      local: true,
      structuredToolMode: 'separate-turn',
      complete: async (input) => {
        requests.push(input);
        return {
          model: 'qwen3:4b',
          finish: 'stop',
          message: {
            role: 'assistant',
            content: requests.length === 1 ? invalidPlan : correctedPlan,
          },
          usage: { inputTokens: 300, outputTokens: requests.length === 1 ? 1500 : 100 },
        };
      },
    },
    requestPolicy: {
      revision: conservativeRequestPolicy.revision,
      prepare: (input) => {
        const decision = conservativeRequestPolicy.prepare(input);
        decisions.push(decision);
        return decision;
      },
    },
    budgets: {
      reserveGeneration: async (input) => {
        grants.push(input.requestedOutputTokens);
        return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
      },
      recordUsage: async () => {},
      reserveTools: async () => {
        toolsReserved++;
      },
    },
    tools: {
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read a permitted input',
          parameters: { type: 'object' },
        },
      ],
      execute: async () => {
        effects++;
        return { content: 'Must not run while planning' };
      },
    },
    idGenerator: () => String(++nextId),
    limits: {
      contextTokens: 16384,
      maxOutputTokens: 2048,
      maxRequestsPerTurn: 4,
      maxToolCallsPerTurn: 8,
      maxSessionRequests: 8,
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'R-fixture',
    purpose: 'coordination',
    instructions,
  });
  const turn = (text: string) =>
    runtime.turn(threadId, text, {
      schema: teamOutputSchema,
      toolPolicy: 'none',
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
  return {
    runtime,
    sessions,
    threadId,
    requests,
    decisions,
    grants,
    turn,
    toolCounts: () => ({ reserved: toolsReserved, effects }),
  };
}

test('compact correction handles a verbose plan on the same actual 16K managed session with useful output headroom', async (t) => {
  const f = await fixture(t),
    input = source();
  assert.ok(invalidPlan.length >= 5250 && invalidPlan.length <= 5500);
  const first = planningTurn({ ...input });
  const corrected = planningTurn({
    ...input,
    reuseBrief: true,
    correction: correction(),
  });
  await f.turn(first.text);
  const result = await f.turn(corrected.text);
  const saved = (await f.sessions.load(f.threadId))!;
  assert.equal(f.requests.length, 2);
  assert.ok(f.decisions[1].maxOutputTokens >= 1024, JSON.stringify(f.decisions));
  assert.ok(f.grants[1] >= 1024);
  assert.equal(f.requests[1].maxOutputTokens, f.grants[1]);
  assert.deepEqual(TeamPlanSchema.parse(JSON.parse(result.text)), JSON.parse(correctedPlan));
  assert.deepEqual(f.toolCounts(), { reserved: 0, effects: 0 });
  assert.equal(
    saved.messages.filter(
      (message) => message.role === 'user' && message.content.includes('GOAL_SESSION_ATOMICITY'),
    ).length,
    1,
  );
  assert.equal(
    saved.messages.filter((message) => message.role === 'assistant')[0].content,
    invalidPlan,
  );
  assert.deepEqual(
    saved.turnAuthorities!.map((entry) => entry.toolPolicy),
    ['none', 'none'],
  );
  assert.deepEqual(
    saved.turnAuthorities!.map((entry) => entry.startedAtRequest),
    [0, 1],
  );
  assert.equal(saved.requests, 2);
  assert.deepEqual(saved.usage, { requestsWithUsage: 2, inputTokens: 600, outputTokens: 1600 });
  assert.deepEqual(saved.actions, []);
  for (const request of f.requests) {
    assert.deepEqual(request.tools, []);
    assert.deepEqual(request.schema, teamOutputSchema);
  }
});

test('repeating the complete brief cannot discard history and stops before a second HTTP request at the same 16K limit', async (t) => {
  const f = await fixture(t),
    input = source();
  const first = planningTurn({ ...input });
  const corrected = planningTurn({
    ...input,
    reuseBrief: false,
    correction: correction(),
  });
  await f.turn(first.text);
  await assert.rejects(f.turn(corrected.text), { code: 'MODEL_CONTEXT_EXHAUSTED' });
  const saved = (await f.sessions.load(f.threadId))!;
  assert.equal(f.requests.length, 1);
  assert.equal(f.grants.length, 1);
  assert.equal(saved.requests, 1);
  assert.equal(saved.turnAuthorities!.length, 2);
  assert.deepEqual(f.toolCounts(), { reserved: 0, effects: 0 });
  assert.equal(
    saved.messages.filter(
      (message) => message.role === 'user' && message.content.includes('GOAL_SESSION_ATOMICITY'),
    ).length,
    2,
  );
});
