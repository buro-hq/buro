import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiAgentLoopRunner } from '../adapters/agents/pi-loop.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { OllamaProvider } from '../adapters/models/ollama.ts';
import { createBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { conservativeRequestPolicy } from '../core/request-policy.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import { fixtureToolEffect } from './fixtures/tool-broker.ts';

test('a real managed 16K session carries check, review and finish decisions through native format without repeated schema text', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-action-context-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessions = new FileManagedSessions(directory);
  const catalog = createBuiltinExecutionActions();
  const schema = catalog.outputSchema();
  const schemaText = JSON.stringify(schema);
  assert.ok(schemaText.length > 4000, 'Use the actual complete action grammar.');
  const envelope = {
    status: 'success',
    summary: 'Candidate satisfies the scoped task.',
    artifacts: ['src/session.ts'],
    notesForNextAgent: '',
  };
  const decisions = [
    { decision: { action: 'check', input: {} } },
    { decision: { action: 'review', input: { result: envelope } } },
    { decision: { action: 'finish', input: { result: envelope } } },
  ];
  const responses = [
    {
      content: '',
      tool_calls: [
        { function: { index: 0, name: 'read_file', arguments: { path: 'src/session.ts' } } },
      ],
    },
    { content: 'Inspected the assigned source; request service checks next.' },
    { content: JSON.stringify(decisions[0]) },
    { content: 'Checks passed on the recorded revision; request independent review.' },
    { content: JSON.stringify(decisions[1]) },
    { content: 'The recorded review approves this revision; submit it to the acceptance guard.' },
    { content: JSON.stringify(decisions[2]) },
  ];
  const bodies: any[] = [];
  let metadataRequests = 0;
  const provider = new OllamaProvider({
    id: 'controlled-local',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
    fetch: async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/show') {
        metadataRequests++;
        return Response.json({
          capabilities: ['completion', 'tools'],
          model_info: { 'fixture.context_length': 16384 },
        });
      }
      assert.equal(pathname, '/api/chat');
      const body = JSON.parse(String(options?.body));
      bodies.push(body);
      const message = responses[bodies.length - 1];
      assert.ok(message, 'No additional generation is permitted by this controlled transcript.');
      return new Response(
        JSON.stringify({
          model: 'controlled-model',
          message: { role: 'assistant', ...message },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 100,
          eval_count: 60,
        }) + '\n',
        { headers: { 'content-type': 'application/x-ndjson' } },
      );
    },
  });
  assert.equal(provider.structuredOutputMode, 'schema');
  const projects = {
    get: () => ({
      snapshot: () => ({
        project: { id: 'p', root: directory },
        runs: [{ id: 'R-context', workspace: directory }],
      }),
    }),
  } as unknown as ProjectRegistry;
  const reservations: number[] = [];
  const estimates: number[] = [];
  let nextId = 0,
    toolEffects = 0;
  const settings = {
    id: 'controlled-runtime',
    model: 'controlled-model',
    provider,
    projects,
    sessions,
    loopRunner: new PiAgentLoopRunner(),
    idGenerator: () => String(++nextId),
    limits: {
      contextTokens: 16384,
      maxOutputTokens: 2048,
      maxRequestsPerTurn: 8,
      maxToolCallsPerTurn: 8,
      maxSessionRequests: 16,
    },
    requestPolicy: {
      revision: conservativeRequestPolicy.revision,
      prepare(input: Parameters<typeof conservativeRequestPolicy.prepare>[0]) {
        const decision = conservativeRequestPolicy.prepare(input);
        estimates.push(decision.estimatedInput);
        return decision;
      },
    },
    budgets: {
      async reserveGeneration(input: { operationId: string; requestedOutputTokens: number }) {
        reservations.push(input.requestedOutputTokens);
        return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
      },
      recordUsage: async () => {},
      reserveTools: async () => {},
    },
    tools: {
      revision: 'controlled-tools-v1',
      effect: fixtureToolEffect,
      definitions: () => [
        {
          name: 'read_file',
          description: 'Read the assigned source.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      async execute() {
        toolEffects++;
        return { content: 'SOURCE_RECEIPT: exact synchronous session implementation.' };
      },
    },
  };
  const instructions =
    'Coordinate the complete goal, inspect evidence and choose the next action.\nAvailable actions: ' +
    JSON.stringify(catalog.definitions().map(({ id, description }) => ({ id, description })));
  const goal =
    'ORIGINAL_COMPLETE_GOAL: Preserve synchronous session writes and exact old bytes after a failed rename.\n' +
    'Use a unique sibling temporary file, close it before rename, preserve unrelated artifacts and propagate the original error.\n'.repeat(
      16,
    ) +
    'USER_JSON_LITERAL: {"type":"object","properties":{"keep_this_text":{"type":"string"}}}\n' +
    'FINAL_CRITERION: Service checks and fresh review must refer to the same revision; never edit their definitions.';
  let runtime = new ManagedAgentRuntime(settings);
  const start = {
    projectId: 'p',
    runId: 'R-context',
    purpose: 'coordination' as const,
    workspace: directory,
    instructions,
  };
  const { threadId } = await runtime.start(start);
  const turn = (text: string) =>
    runtime.turn(threadId, text, {
      schema,
      signal: new AbortController().signal,
      timeoutMs: 10000,
    });
  assert.deepEqual(JSON.parse((await turn(goal)).text), decisions[0]);
  assert.deepEqual(
    JSON.parse(
      (await turn('SERVICE_CHECK_RECEIPT: all configured checks pass on revision abc.')).text,
    ),
    decisions[1],
  );
  const before = (await sessions.load(threadId))!;
  await runtime.release(threadId);
  runtime = new ManagedAgentRuntime({
    ...settings,
    sessions: new FileManagedSessions(directory),
  });
  await runtime.resume({ ...start, threadId });
  assert.deepEqual(
    JSON.parse(
      (await turn('SERVICE_REVIEW_RECEIPT: fresh independent approval of revision abc.')).text,
    ),
    decisions[2],
  );
  const saved = (await sessions.load(threadId))!;
  await runtime.release(threadId);
  assert.equal(bodies.length, 7);
  assert.equal(metadataRequests, bodies.length);
  assert.equal(toolEffects, 1);
  assert.deepEqual(saved.actions, before.actions);
  assert.equal(saved.requests, 7);
  assert.deepEqual(saved.usage, { requestsWithUsage: 7, inputTokens: 700, outputTokens: 420 });
  assert.ok(saved.messages.some((message) => message.role === 'user' && message.content === goal));
  assert.ok(saved.messages.some((message) => message.content.includes('SOURCE_RECEIPT')));
  assert.ok(saved.messages.some((message) => message.content === JSON.stringify(decisions[0])));
  assert.ok(saved.messages.some((message) => message.content === JSON.stringify(decisions[1])));
  assert.ok(saved.messages.every((message) => !message.content.includes(schemaText)));
  assert.deepEqual(reservations, Array(7).fill(2048));
  assert.equal(estimates.length, 7);
  assert.ok(estimates.every((estimate) => estimate + 2048 <= 16384));
  t.diagnostic(
    `Seven generations; maximum estimated input ${Math.max(...estimates)}; all output reservations 2048; response grammar ${schemaText.length} bytes.`,
  );
  const formatted = bodies.filter((body) => body.format !== undefined);
  assert.equal(formatted.length, 3);
  for (const body of bodies) {
    assert.equal(body.options.num_ctx, 16384);
    assert.equal(body.options.num_predict, 2048);
    assert.ok(
      body.messages.some(
        (message: any) => message.role === 'user' && message.content.includes(goal),
      ),
    );
    assert.ok(body.messages.every((message: any) => !message.content.includes(schemaText)));
    if (body.format !== undefined) {
      assert.deepEqual(body.format, schema);
      assert.deepEqual(body.tools, []);
    } else assert.ok(body.tools.length > 0);
  }
});
