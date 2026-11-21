import type { Role, Run } from '../protocol/domain.ts';
import { ContextMaterialSchema } from '../protocol/context.ts';
import {
  WorkerTaskSchema,
  type WorkerEnvelopeV1,
  type WorkerTask,
} from '../protocol/worker-tasks.ts';
import { DomainError } from './ports.ts';
import { planPathAllowed, type ExecutionPolicy } from './execution-ports.ts';

export const DEFAULT_WORKER_ENVELOPE_BYTES = 128 * 1024;
const CHECK_DIAGNOSTIC_BYTES = 2048;
const encoder = new TextEncoder();
const excerptMarker = '\n[Excerpt; complete check log is retained in the run.]\n';

/** File inputs grant no write authority; actual reads still pass through the ToolBroker. */
export function publicWorkerInput(file: string) {
  if (
    !file ||
    file.startsWith('/') ||
    /[\\:*?\[\]{}!\u0000-\u001f]/.test(file) ||
    /\.(?:pem|key|p12|pfx|keystore)$/i.test(file)
  )
    return false;
  return file
    .split('/')
    .every(
      (part) =>
        !!part &&
        !['.', '..'].includes(part) &&
        !/^(?:\.git|\.buro|\.codex|\.aws|\.ssh|node_modules|\.env(?:\..*)?|.*\.env|\.npmrc|\.netrc|\.git-credentials|credentials|private)$/i.test(
          part,
        ),
    );
}

export function validateWorkerTask(task: unknown): WorkerTask {
  const parsed = WorkerTaskSchema.safeParse(task);
  if (!parsed.success)
    throw new DomainError('INVALID_ASSIGNMENT', 'The saved worker task is invalid.');
  if (parsed.data.inputs.some((file) => !publicWorkerInput(file)))
    throw new DomainError('INVALID_ASSIGNMENT', 'Worker inputs require exact public file paths.');
  return parsed.data;
}

function takeBytes(value: string, maximum: number, fromEnd = false) {
  let result = '',
    bytes = 0;
  // Code points, rather than UTF-16 slices, keep Unicode diagnostics well formed.
  const points = fromEnd ? Array.from(value).reverse() : value;
  for (const point of points) {
    const size = encoder.encode(point).length;
    if (bytes + size > maximum) break;
    result = fromEnd ? point + result : result + point;
    bytes += size;
  }
  return result;
}

function excerpt(value: string, maximum: number) {
  if (encoder.encode(value).length <= maximum) return value;
  const remaining = maximum - encoder.encode(excerptMarker).length;
  if (remaining < 2) return '';
  const first = Math.floor(remaining / 2);
  return takeBytes(value, first) + excerptMarker + takeBytes(value, remaining - first, true);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function workerInstructions(role: Role, policy: ExecutionPolicy) {
  const scopeInstructions =
    policy.scope.mode === 'strict'
      ? 'Write only within your assigned planned paths. Protected paths are always forbidden. Exploratory commands and intermediate worker checks are unavailable in strict mode because they could write outside those paths; the service still runs final immutable acceptance checks.'
      : 'Your assigned paths describe planned work. You may edit additional files inside this working copy when needed to complete the task. Explain additional edits and interactions with existing changes. Protected paths are always forbidden.';
  return (
    role.instructions +
    '\nYou are a worker assigned by Buro. ' +
    scopeInstructions +
    ' Do not start agents, commit, reset, checkout, modify .git or change check definitions. Buro owns other assignments and independent acceptance. Make native tool calls directly; do not print internal planning or <think> blocks. Finish with a brief factual result.' +
    (policy.context ? '\nProject context: ' + policy.context : '')
  );
}

export function workerPrompt(envelope: WorkerEnvelopeV1) {
  const scopeInstructions =
    envelope.scope.mode === 'strict'
      ? 'Do not write outside scope.plannedPaths or modify protected paths.'
      : 'scope.plannedPaths are the plan, not a write boundary. Make necessary adjacent edits inside this working copy and report them; protected paths remain forbidden.';
  return (
    'Execute your assigned work in the existing workspace.\n' +
    `Role: ${envelope.role.id}.\n` +
    'Saved assignment v1 (file inputs are references, not extra write authority):\n' +
    JSON.stringify(envelope) +
    '\nInspect the listed inputs and relevant read-only materials when needed. Complete only this task. ' +
    scopeInstructions +
    ' Do not repeat completed external actions. Return the formal execution result with concrete changes, evidence and limitations; the service runs independent acceptance.'
  );
}

/** Derive a detached, immutable request from a saved plan; never summarize away task requirements. */
export function buildWorkerEnvelope(options: {
  run: Run;
  role: Role;
  paths: string[];
  policy: ExecutionPolicy;
  workspace: string;
  maxBytes?: number;
}): WorkerEnvelopeV1 {
  const { run, role, paths, policy, workspace } = options;
  const savedPaths =
    run.roleAssignments && Object.hasOwn(run.roleAssignments, role.id)
      ? run.roleAssignments[role.id]
      : undefined;
  if (
    !savedPaths ||
    (policy.scope.mode === 'strict' && !savedPaths.length) ||
    savedPaths.length !== paths.length ||
    savedPaths.some((file, index) => file !== paths[index]) ||
    paths.some((file) => !planPathAllowed(file, policy.scope))
  )
    throw new DomainError('INVALID_ASSIGNMENT', 'The worker envelope requires its saved scope.');
  const savedRole = run.roleSnapshots?.find((candidate) => candidate.id === role.id);
  if (
    savedRole &&
    (savedRole.version !== role.version ||
      savedRole.instructions !== role.instructions ||
      savedRole.kind !== role.kind)
  )
    throw new DomainError('INVALID_ASSIGNMENT', 'The worker role differs from its saved version.');
  const task =
    run.workerTasks && Object.hasOwn(run.workerTasks, role.id)
      ? run.workerTasks[role.id]
      : undefined;
  const compact = task === undefined ? undefined : validateWorkerTask(task);
  const collection = run.acceptance.total ? 'acceptance' : 'baseline';
  const checks = run[collection];
  const failures = checks.results.filter((check) => !check.passed && (check.error || check.output));
  const diagnosticBytes = Math.min(
    1024,
    Math.floor(CHECK_DIAGNOSTIC_BYTES / Math.max(1, failures.length)),
  );
  const folder = workspace.replaceAll('\\', '/').replace(/\/$/, '') + '/.buro/';
  const materials = (run.contextMaterials || []).map((material) => {
    const validated = ContextMaterialSchema.safeParse(material);
    if (!validated.success)
      throw new DomainError('INVALID_ASSIGNMENT', 'A saved material reference is invalid.');
    const item = validated.data;
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      hash: item.hash,
      path: folder + (item.textPath || item.relativePath).replace(/^local\//, ''),
      ...(item.note !== undefined ? { note: item.note } : {}),
    };
  });
  const envelope: WorkerEnvelopeV1 = {
    version: 1,
    runId: run.id,
    role: { id: role.id, version: role.version },
    goal: { ...(run.goalId ? { id: run.goalId } : {}), title: run.title },
    task: compact
      ? {
          source: 'coordinator',
          ...compact,
          inputs: [...compact.inputs],
          criteria: [...compact.criteria],
        }
      : {
          source: 'legacy-goal',
          objective: run.goalText,
          inputs: paths.filter(publicWorkerInput),
          expectedResult:
            'Complete your assigned plan steps and return the formal execution result.',
          criteria: [],
        },
    scope: {
      mode: policy.scope.mode,
      plannedPaths: [...paths],
      protectedPaths: [...policy.scope.protectedPaths],
    },
    steps: run.plan.filter((step) => step.owner === role.id).map((step) => step.step),
    checks: {
      collection,
      passed: checks.passed,
      total: checks.total,
      results: checks.results.map((check, index) => {
        const diagnostic = check.passed
          ? ''
          : excerpt(
              [...new Set([check.error, check.output].filter(Boolean))].join('\n'),
              diagnosticBytes,
            );
        return {
          index,
          name: check.name,
          passed: check.passed,
          ...(check.command !== undefined ? { command: check.command } : {}),
          ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        };
      }),
    },
    materials,
    ...(run.continuation ? { clarification: run.continuation.instructions } : {}),
  };
  const maximum = options.maxBytes ?? DEFAULT_WORKER_ENVELOPE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new DomainError('INVALID_ASSIGNMENT', 'The worker envelope byte budget is invalid.');
  if (
    encoder.encode(workerInstructions(role, policy) + '\n' + workerPrompt(envelope)).length >
    maximum
  )
    throw new DomainError(
      'WORKER_ENVELOPE_TOO_LARGE',
      'The saved assignment exceeds its request envelope budget. Create a focused assignment; no task requirements were omitted.',
    );
  return freeze(envelope);
}
