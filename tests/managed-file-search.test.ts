import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ManagedAgentRuntime } from '../core/managed-runtime.ts';
import { FileManagedSessions } from '../adapters/files/managed-sessions.ts';
import { RepositoryTools } from '../adapters/tools/repository-tools.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { boundedWorkSegmentPolicy, type SegmentEvidence } from '../core/work-segments.ts';
import type { ModelMessage, ModelProvider, ModelToolCall } from '../core/model-ports.ts';
import type { ProjectRegistry } from '../core/ports.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const response = (content = '{"ok":true}') => ({
  model: 'fixture-model',
  finish: 'stop' as const,
  message: { role: 'assistant' as const, content },
});
const tool = (id: string, name: string, args: unknown) => ({
  model: 'fixture-model',
  finish: 'tools' as const,
  message: { role: 'assistant' as const, content: '', toolCalls: [{ id, name, arguments: args }] },
});

test('file search feeds real edits and check-feedback repair without widening a managed worker assignment', async (t) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-managed-search-')),
  );
  const owned = 'src/value.ts',
    protectedFile = 'checks/acceptance.txt';
  await fs.mkdir(path.join(directory, 'src'));
  await fs.mkdir(path.join(directory, 'checks'));
  await fs.writeFile(path.join(directory, owned), 'export const value = 1;\n');
  const frozenCheck = 'The complete implementation must export value = 2.\n';
  await fs.writeFile(path.join(directory, protectedFile), frozenCheck);
  const sessions = new FileManagedSessions(path.join(directory, '.buro/managed'));
  const requests: Parameters<ModelProvider['complete']>[0][] = [];
  const toolReservations: number[] = [];
  const executed: ModelToolCall[] = [];
  let serial = 0,
    checkRuns = 0,
    generationReservations = 0;
  let observed: { path: string; line: number; text: string } | undefined;
  const lastTool = (messages: ModelMessage[]) => {
    const last = messages.at(-1)!;
    assert.equal(last.role, 'tool');
    return last;
  };
  const searchResult = (messages: ModelMessage[], expected: string) => {
    const last = lastTool(messages);
    assert.equal(last.toolName, 'search_text');
    const result = JSON.parse(last.content);
    assert.equal(
      result.matches.length,
      1,
      'The requested file must be searched directly, not traversed as a directory',
    );
    assert.equal(result.matches[0].path, owned);
    assert.equal(result.matches[0].text, expected);
    return result.matches[0] as { path: string; line: number; text: string };
  };
  const provider: ModelProvider = {
    id: 'fixture-ollama',
    revision: '1',
    local: true,
    structuredToolMode: 'separate-turn',
    complete: async (input) => {
      requests.push(input);
      switch (requests.length) {
        case 1:
          return tool('search-original', 'search_text', { path: owned, query: 'value =' });
        case 2:
          observed = searchResult(input.messages, 'export const value = 1;');
          return tool('forbidden-edit', 'edit_file', {
            path: protectedFile,
            oldText: frozenCheck,
            newText: 'Accept any value.\n',
          });
        case 3:
          assert.match(lastTool(input.messages).content, /outside the assignment/);
          return tool('initial-edit', 'edit_file', {
            path: observed!.path,
            oldText: observed!.text,
            newText: observed!.text.replace('= 1', '= 3'),
          });
        case 4:
          assert.equal(lastTool(input.messages).content, 'Edited ' + owned);
          return response('The first implementation is complete.');
        case 5:
          assert.match(input.messages.at(-1)!.content, /expected value 2/);
          assert.ok(input.tools.some((definition) => definition.name === 'search_text'));
          return tool('search-repair', 'search_text', { path: owned, query: 'value =' });
        case 6:
          observed = searchResult(input.messages, 'export const value = 3;');
          return tool('repair-edit', 'edit_file', {
            path: observed.path,
            oldText: observed.text,
            newText: observed.text.replace('= 3', '= 2'),
          });
        case 7:
          assert.equal(lastTool(input.messages).content, 'Edited ' + owned);
          return response('The focused repair is complete.');
        case 8:
          assert.deepEqual(input.tools, []);
          return response();
        default:
          throw Error('Unexpected extra model generation.');
      }
    },
  };
  const repositoryTools = new RepositoryTools(new EnvironmentExecutors());
  const runtime = new ManagedAgentRuntime({
    id: 'managed-fixture',
    model: 'fixture-model',
    provider,
    sessions,
    projects: {
      get: () => ({
        snapshot: () => ({
          project: { id: 'p', root: directory },
          runs: [{ id: 'R-owner', workspace: directory, baseCommit: 'a'.repeat(40) }],
        }),
      }),
    } as unknown as ProjectRegistry,
    idGenerator: () => String(++serial),
    limits: {
      contextTokens: 65536,
      maxOutputTokens: 512,
      maxRequestsPerTurn: 10,
      maxToolCallsPerTurn: 10,
      maxSessionRequests: 12,
    },
    tools: {
      definitions: (scope) => repositoryTools.definitions(scope),
      execute: async (call, scope, options) => {
        executed.push(structuredClone(call));
        return repositoryTools.execute(call, scope, options);
      },
    },
    budgets: {
      reserveGeneration: async (input) => {
        generationReservations++;
        return { operationId: input.operationId, maxOutputTokens: input.requestedOutputTokens };
      },
      recordUsage: async () => {},
      reserveTools: async (input) => {
        toolReservations.push(input.count);
      },
    },
    segmentPolicy: {
      ...boundedWorkSegmentPolicy,
      revision: 'file-search-integration-v1',
      limits: {
        revision: 'file-search-integration-v1',
        maxToolRounds: 6,
        maxSegments: 3,
        contextThresholdPercent: 80,
      },
    },
    segmentEvidence: {
      inspect: async (_scope, signal): Promise<SegmentEvidence> => {
        signal.throwIfAborted();
        const files = await Promise.all(
          [owned, protectedFile].map(async (file) => ({
            path: file,
            fingerprint: hash(await fs.readFile(path.join(directory, file), 'utf8')),
          })),
        );
        files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        return {
          version: 1,
          baseCommit: 'a'.repeat(40),
          headCommit: 'a'.repeat(40),
          workspaceFingerprint: hash(JSON.stringify(files)),
          files,
        };
      },
    },
    workerStepChecks: {
      plan: () => ({
        version: 1,
        checkIds: ['frozen-value'],
        configurationRevision: hash(frozenCheck),
      }),
      run: async (_scope, plan, fingerprint, signal) => {
        signal.throwIfAborted();
        checkRuns++;
        assert.equal(await fs.readFile(path.join(directory, protectedFile), 'utf8'), frozenCheck);
        const passed =
          (await fs.readFile(path.join(directory, owned), 'utf8')) === 'export const value = 2;\n';
        return {
          version: 1,
          outcome: 'completed',
          workspaceFingerprint: fingerprint,
          checkIds: [...plan.checkIds],
          passed: passed ? 1 : 0,
          total: 1,
          results: [
            {
              id: 'frozen-value',
              name: 'Frozen value check',
              status: passed ? 'passed' : 'failed',
              exitCode: passed ? 0 : 1,
              diagnostic: passed ? '' : 'expected value 2',
            },
          ],
        };
      },
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { threadId } = await runtime.start({
    projectId: 'p',
    runId: 'R-owner',
    purpose: 'implementation',
    workspace: directory,
    instructions: 'Implement only the assigned source file.',
    assignment: {
      sessionId: 'S-worker',
      roleId: 'builder',
      allowedPaths: [owned],
      protectedPaths: ['checks/'],
    },
  });
  const original = (await sessions.load(threadId))!;
  const result = await runtime.turn(
    threadId,
    'Export value 2 and preserve every protected check.',
    { schema: { type: 'object' }, signal: new AbortController().signal, timeoutMs: 2000 },
  );
  const saved = (await sessions.load(threadId))!;
  assert.equal(result.text, '{"ok":true}');
  assert.equal(await fs.readFile(path.join(directory, owned), 'utf8'), 'export const value = 2;\n');
  assert.equal(await fs.readFile(path.join(directory, protectedFile), 'utf8'), frozenCheck);
  assert.equal(checkRuns, 2);
  assert.equal(saved.requests, 8);
  assert.equal(generationReservations, 8);
  assert.equal(
    toolReservations.reduce((sum, count) => sum + count, 0),
    7,
    'Both frozen service checks and all five model actions consume the cumulative allowance',
  );
  assert.equal(executed.length, 5);
  assert.deepEqual(
    saved.actions.map((action) => action.call.name),
    ['search_text', 'edit_file', 'edit_file', 'search_text', 'edit_file'],
  );
  assert.equal(saved.actions[1].result!.isError, true);
  assert.ok(saved.actions.every((action) => action.status === 'completed'));
  assert.deepEqual(saved.scope, original.scope);
  assert.deepEqual(saved.scopeRevisions, original.scopeRevisions);
  assert.equal(saved.turnAuthorities!.length, 1);
  assert.equal(saved.turnAuthorities![0].toolPolicy, 'normal');
  assert.equal(saved.workerStepChecks!.feedbackSteps, 1);
  assert.deepEqual(
    saved.workerStepChecks!.entries.map((entry) => entry.result!.passed),
    [0, 1],
  );
  assert.equal(saved.workSegments!.archives.length, 1);
  assert.equal(saved.workSegments!.archives[0].handoff.kind, 'check-feedback');
  assert.match(
    saved.workSegments!.archives[0].messages.find((message) => message.toolName === 'search_text')!
      .content,
    /export const value = 1;/,
  );
});
