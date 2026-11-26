import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendRequest } from '../modules/engines/backend.ts';
import type { ModelCompletion } from '../agent/contracts/model.ts';
import { createApplication } from '../modules/application/create-application.ts';
import { SqliteStorage } from '../modules/storage/sqlite-storage.ts';
import type { Run } from '../modules/runs/run.ts';
import { apiMethods } from '../modules/api/dispatch.ts';
import type { ReviewSettings } from '#shared/contracts';

const exec = promisify(execFile);
const answer = (content: string): ModelCompletion => ({ model: 'fixture', finish: 'stop', message: { role: 'assistant', content } });
const call = (name: string, args: unknown): ModelCompletion => ({
  model: 'fixture',
  finish: 'tools',
  message: { role: 'assistant', content: '', toolCalls: [{ id: 'call-' + name, name, arguments: args }] },
});
interface FixtureOptions {
  cannotFix?: boolean;
  reportFails?: boolean;
  blockReview?: boolean;
  readOnly?: boolean;
}
const fixture = async (t: { after(callback: () => Promise<void>): void }, options: FixtureOptions = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-review-'));
  const source = path.join(directory, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'initial');
  await exec('git', ['init', '-q', source]);
  await exec('git', ['add', '.'], {
    cwd: source,
  });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial'], {
    cwd: source,
  });
  const requests: BackendRequest[] = [];
  let executorId: string | undefined;
  const inspected = new Set<string>();
  const checked = new Set<string>();
  let started!: () => void;
  const reviewStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const app = await createApplication({
    directory: path.join(directory, 'state'),
    transports: [{
      id: 'fixture',
      create({ configuration }) {
        return {
          id: configuration.id,
          revision: configuration.revision,
          async complete(request) {
            requests.push(structuredClone({
              ...request,
              executeTool: undefined,
              signal: undefined,
              onProgress: undefined,
              onEvent: undefined,
              onRetry: undefined,
            }) as unknown as BackendRequest);
            executorId ??= request.sessionId;
            const value = await fs.readFile(path.join(request.workspace, 'value.txt'), 'utf8');
            if (request.sessionId === executorId) {
              const corrections = request.messages.some((message) => message.role === 'user' && message.content.includes('Independent review found'));
              const writeObserved = request.messages.some((message) => message.role === 'tool' && message.toolName === 'write_file');
              if (options.readOnly)
                return answer('Read-only inspection completed.');

              if (corrections && value !== 'fixed' && !checked.has('correction')) {
                checked.add('correction');
                return call('write_file', {
                  path: 'value.txt',
                  content: options.cannotFix ? 'initial' : 'fixed',
                });
              }

              if (!writeObserved)
                return call('write_file', {
                  path: 'value.txt',
                  content: 'initial',
                });

              return answer(corrections ? 'Corrections completed.' : 'Implementation completed.');
            }

            started();
            if (options.blockReview)
              await new Promise<void>((_, reject) => {
                if (request.signal.aborted)
                  reject(new Error('Stopped'));
                else
                  request.signal.addEventListener('abort', () => reject(new Error('Stopped')), {
                    once: true,
                  });
              });

            if (request.schema)
              return answer(options.reportFails
                ? 'Unstructured review.'
                : JSON.stringify({
                    summary: value === 'fixed' ? 'Verified.' : 'A confirmed defect remains.',
                    findings: value === 'fixed' ? [] : [{ message: 'value.txt must contain fixed.', path: 'value.txt', line: 1 }],
                  }));

            if (!inspected.has(request.sessionId)) {
              inspected.add(request.sessionId);
              return call('read_file', {
                path: 'value.txt',
              });
            }

            if (!options.readOnly && !checked.has(request.sessionId)) {
              checked.add(request.sessionId);
              return call('command', {
                command: `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('value.txt','utf8')==='fixed'?0:1)"`,
              });
            }

            return answer('Inspected the file and observed the available checks.');
          },
        };
      },
    }],
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  });
  for (const id of ['maker', 'alternate'])
    await app.modelConfigurations.save({
      configuration: { id, name: id, model: id, transport: 'fixture' },
      default: id === 'maker',
    });
  const project = (await app.projects.connect({
    root: source,
  })).project!;
  const task = await app.tasks.create({
    projectId: project.id,
    title: 'Set value.txt to fixed',
    description: 'Keep the change simple and verify it.',
  });
  const review: ReviewSettings = {
    enabled: true,
    maxRounds: 2,
    participants: [
      { name: 'Any label', instructions: 'Check behavior.', modelId: 'alternate', tools: ['read_file', 'command', 'ungranted'] },
      { name: 'A different label', instructions: 'Check simplicity.' },
    ],
  };
  return { app, task, review, requests, reviewStarted, source, directory };
};

test('independent reviewers automatically return findings, the executor fixes real files, and fresh reviews verify the result', async (t) => {
  const f = await fixture(t);
  await f.app.settings.update({
    review: f.review,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { tools: ['read_file', 'write_file', 'command'] },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.status, 'completed');
  assert.equal(run.review?.status, 'completed');
  assert.equal(await fs.readFile(path.join(run.workspace, 'value.txt'), 'utf8'), 'fixed');
  assert.equal(run.review?.reports.length, 4);
  assert.deepEqual(run.review?.reports.map((review) => review.round), [1, 1, 2, 2]);
  assert.equal(run.review?.reports.slice(0, 2).every((review) => review.findings?.length === 1), true);
  assert.equal(run.review?.reports.slice(2).every((review) => review.findings?.length === 0), true);
  assert.equal(run.review?.reports.slice(0, 2).every((review) => review.commands?.some((command) => command.failed && command.exitCode === 1)), true);
  assert.equal(run.review?.reports.slice(2).every((review) => review.commands?.some((command) => !command.failed && command.exitCode === 0)), true);
  const firstReview = run.review!.reports[0];
  const request = f.requests.find((request) => request.sessionId === firstReview.sessionId)!;
  assert.equal(request.model, 'alternate');
  assert.equal(request.messages.length, 2, 'A reviewer starts with fresh context instead of the executor transcript.');
  assert.deepEqual(request.tools.map((tool) => tool.name).sort(), ['command', 'read_file']);
  assert.equal(f.requests.some((request) => request.sessionId === run.sessionId && request.messages.some((message) => message.role === 'user' && message.content.includes('value.txt must contain fixed.'))), true);
  assert.equal((await f.app.sessions.list({
    runId: run.id,
  })).length, 5);
});

test('a run can disable application review without changing the defaults', async (t) => {
  const f = await fixture(t);
  await f.app.settings.update({
    review: f.review,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: { enabled: false } },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.review, undefined);
  assert.equal((await f.app.sessions.list({
    runId: run.id,
  })).length, 1);
  assert.equal((await f.app.settings.get()).review?.enabled, true);
});

test('review participants receive the shared run policy while keeping their own instructions', async (t) => {
  const f = await fixture(t);
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: { ...f.review, maxRounds: 1 }, instructions: 'House review policy' },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.review === undefined, false);
  const reviewSessions = (await f.app.sessions.list({
    runId: run.id,
  })).filter((session) => session.id !== run.sessionId);
  assert.equal(reviewSessions.length, 2);
  assert.equal(reviewSessions.every((session) => session.policy === 'House review policy'), true);
  assert.equal(reviewSessions.every((session) => session.instructions.includes('Independently review the actual task result')), true);
});

test('a review report failure remains visible without discarding the implementation', async (t) => {
  const f = await fixture(t, {
    reportFails: true,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: f.review },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.status, 'completed');
  assert.equal(run.review?.status, 'failed');
  assert.equal(run.review?.reports.every((review) => review.status === 'failed'), true);
  assert.equal(await fs.readFile(path.join(run.workspace, 'value.txt'), 'utf8'), 'initial');
});

test('cancellation joins an active independent review and preserves the current files', async (t) => {
  const f = await fixture(t, {
    blockReview: true,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: f.review },
  });
  await f.reviewStarted;
  f.app.runs.cancel({
    id: started.run!.id,
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.review?.status, 'interrupted');
  assert.equal(run.review?.reports[0].status, 'interrupted');
  assert.equal((await f.app.sessions.list({
    runId: run.id,
  })).some((session) => session.status === 'running'), false);
});

test('an explicit round limit records outstanding findings instead of claiming a clean review', async (t) => {
  const f = await fixture(t, {
    cannotFix: true,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: { ...f.review, maxRounds: 1 } },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.status, 'completed');
  assert.equal(run.review?.status, 'limited');
  assert.equal(run.review?.reports.length, 2);
  assert.equal(run.review?.reports.every((report) => report.findings?.length), true);
});

test('read-only work is reviewed but findings do not trigger unauthorized corrections', async (t) => {
  const f = await fixture(t, {
    readOnly: true,
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { readOnly: true, review: f.review },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  assert.equal(run.status, 'completed');
  assert.equal(run.review?.status, 'findings');
  assert.equal(await fs.readFile(path.join(run.workspace, 'value.txt'), 'utf8'), 'initial');
  assert.equal(f.requests.some((request) => request.messages.some((message) => message.role === 'user' && message.content.includes('Independent review found'))), false);
});

test('the API persists editable review data and validates external options', async (t) => {
  const f = await fixture(t);
  const methods = apiMethods(f.app);
  const settings = await methods['settings.update']({
    review: f.review,
  });
  assert.deepEqual(settings.review, f.review);
  await assert.rejects(methods['settings.update']({
    review: { maxRounds: 0 },
  }));
  await assert.rejects(methods['runs.start']({
    taskId: f.task.id,
    options: { review: { enabled: 'yes' } },
  }));
  const initial = await f.app.settings.get();
  initial.review!.participants![0].name = 'Changed outside the store';
  assert.equal((await f.app.settings.get()).review?.participants?.[0].name, 'Any label');
});

test('startup recovery marks unfinished review records interrupted without replaying their actions', async (t) => {
  const f = await fixture(t);
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { review: f.review },
  });
  const run = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  const storage = new SqliteStorage({
    filename: path.join(f.directory, 'state/private/state.sqlite'),
  });
  try {
    await storage.records<Run>('runs').patch({
      id: run.id,
      changes: {
        status: 'running',
        review: {
          ...run.review!,
          status: 'running',
          reports: run.review!.reports.map((report, index) => index === run.review!.reports.length - 1
            ? { ...report, status: 'running' }
            : report),
        },
      },
    });
  } finally {
    await storage.close();
  }
  const requests = f.requests.length;
  await f.app.runs.recover();
  const recovered = await f.app.runs.get({
    id: run.id,
  });
  assert.equal(recovered?.status, 'interrupted');
  assert.equal(recovered?.review?.status, 'interrupted');
  assert.equal(recovered?.review?.reports.at(-1)?.status, 'interrupted');
  assert.equal(f.requests.length, requests);
});

test('a continuation reuses the policy saved by the previous attempt', async (t) => {
  const f = await fixture(t);
  await f.app.settings.update({
    review: { enabled: false },
  });
  const started = await f.app.runs.start({
    taskId: f.task.id,
    options: { instructions: 'House continuation policy' },
  });
  const first = (await f.app.runs.wait({
    id: started.run!.id,
  }))!;
  const second = (await f.app.runs.retry({
    id: first.id,
  })).run!;
  await f.app.runs.wait({
    id: second.id,
  });
  const continued = await f.app.sessions.get({
    id: second.sessionId,
  });
  assert.equal(continued?.policy, 'House continuation policy');
  assert.equal(continued?.instructions, '');
});
