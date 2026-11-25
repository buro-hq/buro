import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../modules/application/create-application.ts';
import { SandboxedCommands } from '../modules/commands/sandboxed-commands.ts';
import { safeGit } from '../modules/repositories/git.ts';
import type { SessionBackend, BackendRequest } from '../modules/engines/backend.ts';
import type { ModelCompletion, ModelTiming } from '../agent/contracts/model.ts';
import fixture from './fixtures/ready-queue.json' with { type: 'json' };

interface RequestMeasurement {
  requestId: string;
  sessionId: string;
  wallSeconds: number;
  reportedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  timing?: ModelTiming;
  privateContinuationObserved?: boolean;
  finish?: string;
  failed?: boolean;
  retries?: { attempt: number; errorCode: string; delayMs: number }[];
  failureCode?: string;
}

/** Observes a backend without changing requests, tools, continuation or completion behavior. */
class MeasuredBackend implements SessionBackend {
  readonly id: string;
  readonly revision: string;
  private backend: SessionBackend;
  readonly requests: RequestMeasurement[] = [];
  constructor(input: { backend: SessionBackend }) {
    this.backend = input.backend;
    this.id = input.backend.id;
    this.revision = input.backend.revision;
  }

  contextMessages: SessionBackend['contextMessages'] = (messages) =>
    this.backend.contextMessages?.(messages) ?? structuredClone([...messages]);

  async complete(input: BackendRequest): Promise<ModelCompletion> {
    const started = performance.now();
    const measurement: RequestMeasurement = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      wallSeconds: 0,
    };
    this.requests.push(measurement);
    try {
      const response = await this.backend.complete({
        ...input,
        onRetry: (retry) => {
          (measurement.retries ??= []).push(retry);
          input.onRetry?.(retry);
        },
      });
      Object.assign(measurement, {
        reportedModel: response.model,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        timing: response.timing,
        privateContinuationObserved: response.message.continuation !== undefined,
        finish: response.finish,
      });
      return response;
    } catch (error) {
      measurement.failed = true;
      measurement.failureCode =
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
      throw error;
    } finally {
      measurement.wallSeconds = (performance.now() - started) / 1000;
    }
  }
}

const oracle = `
import {readFileSync,writeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const parse=JSON.parse.bind(JSON), stringify=JSON.stringify.bind(JSON), freeze=Object.freeze;
const request=parse(readFileSync(0,'utf8'));
function frozen(value){if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);freeze(value);}return value;}
frozen(request.inputs);
const {priorityOf}=await import(pathToFileURL(process.argv[1]+'/src/priority.mjs').href);
const {selectReady}=await import(pathToFileURL(process.argv[1]+'/src/queue.mjs').href);
const rows=[];
for(const input of request.inputs){const before=stringify(input);try{const value=Object.hasOwn(input,'task')?priorityOf(input.task):Array.from(selectReady(input.tasks,input.done),task=>task.id);rows.push({value,unchanged:stringify(input)===before});}catch{rows.push({error:true});}}
writeSync(1,stringify({nonce:request.nonce,rows}));
`;

type OracleCase = { name: string; expected: unknown } & Record<string, unknown>;
interface Verification {
  passed: number;
  total: number;
  checks: { name: string; passed: boolean }[];
  error?: string;
}

/** Evaluates behavior in a read-only process, keeping expected values in the parent. */
const verify = async (input: {
  commands: SandboxedCommands;
  workspace: string;
  source: string;
  cases: OracleCase[];
}): Promise<Verification> => {
  const nonce = randomUUID();
  const inputs = input.cases.map(({ name: _name, expected: _expected, ...value }) => value);
  const result = await input.commands.run({
    workspace: input.workspace,
    source: input.source,
    argv: [process.execPath, '--input-type=module', '-e', oracle, input.workspace],
    stdin: JSON.stringify({
      nonce,
      inputs,
    }),
    readOnly: true,
    allowNetwork: false,
    timeoutMs: 10000,
    signal: new AbortController().signal,
  });
  const checks = input.cases.map((entry) => ({ name: entry.name, passed: false }));
  try {
    if (result.exitCode !== 0 || result.error)
      return {
        passed: 0,
        total: checks.length,
        checks,
        error: 'The independent verifier could not complete.',
      };

    const reply = JSON.parse(result.stdout) as {
      nonce: string;
      rows: { value?: unknown; unchanged?: boolean }[];
    };
    if (reply.nonce !== nonce || reply.rows.length !== input.cases.length)
      throw new Error('Invalid verifier response.');

    checks.forEach((check, index) => {
      check.passed =
        reply.rows[index].unchanged === true &&
        JSON.stringify(reply.rows[index].value) === JSON.stringify(input.cases[index].expected);
    });
    return { passed: checks.filter((check) => check.passed).length, total: checks.length, checks };
  } catch {
    return {
      passed: 0,
      total: checks.length,
      checks,
      error: 'The independent verifier returned an invalid response.',
    };
  }
};

const scenario = process.argv[2] ?? 'queue';
if (!['queue', 'review'].includes(scenario))
  throw new Error('Use evaluate-model.ts queue|review [MODEL_CONNECTION_ID].');

const harnessHash = createHash('sha256')
  .update(await fs.readFile(new URL(import.meta.url)))
  .digest('hex');
let sourceRevision: string | undefined;
try {
  sourceRevision = (await safeGit(['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
  })).stdout.trim();
} catch {
  /* Source distributions may have no host repository. */
}
const directory = path.resolve(process.env.PROJECT_DATA_DIR ?? '.buro');
const output = path.resolve(
  'artifacts/model-evaluation',
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + scenario,
);
await fs.mkdir(output, {
  recursive: true,
  mode: 0o700,
});
const source = path.join(output, 'source');
await fs.mkdir(source);
const files: Record<string, string> = structuredClone(fixture.files);
if (scenario === 'review') {
  files['src/priority.mjs'] = files['src/priority.mjs'].replace(
    'task.priority || 2',
    'task.priority ?? 2',
  );
  files['src/queue.mjs'] = files['src/queue.mjs']
    .replace('.some(', '.every(')
    .replace(
      'priorityOf(b) - priorityOf(a)',
      'priorityOf(b) - priorityOf(a) || b.id.localeCompare(a.id)',
    );
}

for (const [relative, text] of Object.entries(files)) {
  const filename = path.join(source, relative);
  await fs.mkdir(path.dirname(filename), {
    recursive: true,
  });
  await fs.writeFile(filename, text);
}
await safeGit(['init', '--initial-branch=main', '--quiet'], {
  cwd: source,
});
await safeGit(['add', '.'], {
  cwd: source,
});
await safeGit(
  [
    '-c',
    'user.name=Buro evaluation',
    '-c',
    'user.email=evaluation@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Evaluation fixture',
  ],
  {
    cwd: source,
  },
);
const app = await createApplication({
  directory,
});
const commands = new SandboxedCommands({
  privatePaths: [path.join(directory, 'private')],
});
const stop = () => {
  process.exitCode = 130;
  void app.stopWork().catch(() => {
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const model = app.models.get(process.argv[3] ? { id: process.argv[3] } : undefined);
  if (!model)
    throw new Error('Save and select a model connection before evaluating it.');

  const configuration = (await app.modelConfigurations.list()).find(
    (connection) => connection.id === model.id,
  );
  const backend = new MeasuredBackend({
    backend: model.backend,
  });
  app.models.register({
    ...model,
    backend,
  });
  const publicCases = fixture.publicCases as OracleCase[];
  const holdoutCases = fixture.holdoutCases as OracleCase[];
  const baseline = {
    public: await verify({
      commands,
      workspace: source,
      source,
      cases: publicCases,
    }),
    holdout: await verify({
      commands,
      workspace: source,
      source,
      cases: holdoutCases,
    }),
  };
  const project = (
    await app.projects.connect({
      root: source,
      name: `${model.name} · ${scenario}`,
    })
  ).project!;
  const task = await app.tasks.create({
    projectId: project.id,
    title:
      scenario === 'queue' ? fixture.task.title : 'Review and fix equal-priority queue ordering',
    description:
      scenario === 'queue'
        ? fixture.task.body + '\n\n' + fixture.task.criteria
        : 'The public examples currently pass. Check whether selectReady preserves original input order for tasks with equal priorities, including tasks without dependencies. Start an independent read-only collaborator to review the implementation, read their findings, fix any actual issue, and ask them to review the changes before you finish. Keep the public APIs and inputs unchanged. Change only src/priority.mjs and src/queue.mjs, without editing checks or adding dependencies. Run appropriate tests and report what was verified.',
  });
  const started = performance.now();
  const created = await app.runs.start({
    taskId: task.id,
    options: { modelId: model.id },
  });
  if (!created.run)
    throw new Error(created.error ?? 'The evaluation run did not start.');

  const runId = created.run.id;
  console.log(
    JSON.stringify({
      started: true,
      scenario,
      runId,
      model: model.model,
      thinkingRequested: configuration?.thinking,
      output,
    }),
  );
  const statuses = new Map<string, string | undefined>();
  const off = app.events.subscribe((notice) => {
    const data = notice.data as { id?: string; runId?: string; status?: string };
    if (
      (notice.type === 'session.updated' && data.runId === runId) ||
      (notice.type === 'run.updated' && data.id === runId)
    )
      if (data.id && statuses.get(data.id) !== data.status) {
        statuses.set(data.id, data.status);
        console.log(JSON.stringify({
          event: notice.type,
          id: data.id,
          status: data.status,
        }));
      }
  });
  const run = (await app.runs.wait({
    id: runId,
  }))!;
  const wallSeconds = (performance.now() - started) / 1000;
  off();
  const sessions = await app.sessions.list({
    runId,
  });
  const activities = await app.activity.list({
    runId,
  });
  const changes = await app.results.inspect({
    runId,
  });
  const verification = {
    public: await verify({
      commands,
      workspace: run.workspace,
      source,
      cases: publicCases,
    }),
    holdout: await verify({
      commands,
      workspace: run.workspace,
      source,
      cases: holdoutCases,
    }),
  };
  const unexpectedFiles = (changes.files ?? []).filter(
    (file) => !['src/priority.mjs', 'src/queue.mjs'].includes(file.path),
  );
  const scope = { passed: changes.ok && unexpectedFiles.length === 0, unexpectedFiles };
  const verified =
    scope.passed && Object.values(verification).every((result) => result.passed === result.total);
  const outputTokens = backend.requests.some((request) => request.outputTokens !== undefined)
    ? backend.requests.reduce((total, request) => total + (request.outputTokens ?? 0), 0)
    : undefined;
  const timedRequests = backend.requests.filter((request) =>
    request.outputTokens !== undefined && (request.timing?.outputSeconds ?? 0) > 0);
  const decodeSeconds = timedRequests.reduce((sum, request) => sum + request.timing!.outputSeconds!, 0);
  const decodeTokens = timedRequests.reduce((sum, request) => sum + request.outputTokens!, 0);
  const userTurns = new Map<string, number>();
  for (const session of sessions) {
    let after = -1;
    let count = 0;
    while (after + 1 < session.messageCount) {
      const page = await app.sessions.history({
        sessionId: session.id,
        after,
        limit: 250,
      });

      if (!page.messages.length)
        break;

      count += page.messages.filter((message) => message.role === 'user').length;
      after = page.start + page.messages.length - 1;
    }
    userTurns.set(session.id, count);
  }
  const report = {
    version: 1,
    sourceRevision,
    harnessHash,
    scenario,
    fixtureId: fixture.id,
    fixtureHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    baseTaskHash: createHash('sha256').update(JSON.stringify(fixture.task)).digest('hex'),
    actualTaskHash: createHash('sha256')
      .update(JSON.stringify({
        title: task.title,
        description: task.description,
      }))
      .digest('hex'),
    model: {
      connectionId: model.id,
      requested: model.model,
      reported: [
        ...new Set(backend.requests.map((request) => request.reportedModel).filter(Boolean)),
      ],
      thinkingRequested: configuration?.thinking,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      sampling: configuration?.sampling,
    },
    run: {
      id: run.id,
      status: run.status,
      workspace: run.workspace,
      result: run.result,
      error: run.error,
    },
    wallSeconds,
    baseline,
    verification,
    scope,
    changedFiles: changes.files,
    requests: backend.requests,
    physicalGenerationAttempts: backend.requests.reduce(
      (total, request) => total + 1 + (request.retries?.length ?? 0),
      0,
    ),
    reportedOutputTokens: outputTokens,
    reportedOutputTokensPerWallSecond:
      outputTokens === undefined ? undefined : outputTokens / wallSeconds,
    // Timings describe reported terminal responses; failed/retried attempts remain in wall time.
    decodeTimingRequests: timedRequests.length,
    decodeTimedOutputTokens: decodeTokens,
    decodeSeconds,
    decodeTokensPerSecond: decodeSeconds > 0 ? decodeTokens / decodeSeconds : null,
    sessions: sessions.map((session) => ({
      id: session.id,
      parentId: session.parentId,
      modelId: session.modelId,
      status: session.status,
      result: session.result,
      error: session.error,
      usage: session.usage,
      userTurns: userTurns.get(session.id),
    })),
    tools: activities
      .filter((activity) => activity.type === 'tool.completed')
      .map((activity) => ({
        name: (activity.data.call as { name?: string })?.name,
        createdAt: activity.createdAt,
      })),
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  if (!process.exitCode && (run.status !== 'completed' || !verified))
    process.exitCode = 1;

  console.log(
    JSON.stringify({
      finished: true,
      scenario,
      status: run.status,
      wallSeconds,
      public: `${verification.public.passed}/${verification.public.total}`,
      holdout: `${verification.holdout.passed}/${verification.holdout.total}`,
      collaborators: sessions.length - 1,
      modelRequests: backend.requests.length,
      report: path.join(output, 'report.json'),
    }),
  );
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await app.close();
  await commands.close();
}
