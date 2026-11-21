import type { Check, Role } from '../protocol/domain.ts';
import type { RuntimeResource } from '../protocol/resources.ts';
import type { WorkScope } from '../protocol/work-scope.ts';
import {
  PlanningPolicySchema,
  planningPolicyMatchesResource,
  type PlanningPolicy,
} from '../protocol/planning-policy.ts';
import { freezeBackendCapabilities } from './backend-capabilities.ts';
import { DomainError } from './ports.ts';

/** Provider context envelope, not a run-wide quota; required goal input is never truncated. */
export const MAX_PLANNING_INPUT_BYTES = 24000;

export function selectPlanningPolicy(resource: RuntimeResource): PlanningPolicy {
  const capabilities = freezeBackendCapabilities(resource.capabilities);
  if (
    !capabilities.structuredTurns ||
    (!capabilities.toolsFreeTurns && !capabilities.readOnlySessions)
  )
    throw new DomainError(
      'PLANNING_UNSUPPORTED',
      'This backend cannot plan safely. Choose structured tools-free planning or a backend with read-only sessions.',
    );
  return Object.freeze({
    version: 1,
    revision: 'capability-planning-v1',
    strategy: capabilities.toolsFreeTurns ? 'tools-free-structured' : 'read-only-inspection',
    runtimeId: resource.id,
    configurationRevision: resource.configurationRevision,
    capabilitiesRevision: capabilities.revision,
  });
}

export function assertPlanningPolicy(policy: PlanningPolicy, resource: RuntimeResource) {
  const parsed = PlanningPolicySchema.safeParse(policy);
  const capabilities = freezeBackendCapabilities(resource.capabilities);
  if (!parsed.success || !planningPolicyMatchesResource(parsed.data, { ...resource, capabilities }))
    throw new DomainError(
      'INVALID_PLANNING_POLICY',
      'The saved planning strategy no longer matches its configured backend and capabilities revision.',
    );
}

type PlanningInput = {
  policy: PlanningPolicy;
  /** Only after the complete brief was sent in this same coordinator thread. */
  reuseBrief?: boolean;
  /** A concurrent role edit requires fresh pins/catalog metadata, not stale history. */
  roleCatalogChanged?: boolean;
  title: string;
  goalText: string;
  scope: WorkScope;
  projectContext?: string;
  maxWorkers: number;
  roles: Role[];
  pool: RuntimeResource[];
  baseline: { passed: number; total: number; results: Check[] };
  repairInstructions?: string;
  correction?: string;
  /** Count the session's fixed instructions too; they accompany every planning request. */
  sessionInstructions?: string;
};

function excerpt(text: string, limit: number) {
  return text.length <= limit ? text : text.slice(0, limit) + ' [shortened]';
}

export function planningBaseline(baseline: PlanningInput['baseline']) {
  const results = [...baseline.results]
    .sort((a, b) => Number(a.passed) - Number(b.passed))
    .slice(0, 12)
    .map(({ name, passed, exitCode, error, output }) => ({
      name: excerpt(name, 120),
      passed,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(!passed
        ? {
            ...(error ? { error: excerpt(error, 300) } : {}),
            ...(output ? { output: excerpt(output, 480) } : {}),
          }
        : {}),
    }));
  return {
    passed: baseline.passed,
    total: baseline.total,
    results,
    omittedResults: baseline.results.length - results.length,
  };
}

export function planningTurn(input: PlanningInput) {
  const strategy = PlanningPolicySchema.parse(input.policy).strategy;
  const toolsFree = strategy === 'tools-free-structured';
  const roles = input.roles.map(({ id, version, title, description, kind, runtimePreference }) => ({
    id,
    version,
    title: excerpt(title, 120),
    description: excerpt(description, 160),
    kind,
    ...(runtimePreference ? { runtimePreference } : {}),
  }));
  if (input.reuseBrief && input.correction) {
    const text = `First, correct the plan using the saved brief and constraints in this thread. Return the complete plan, not a patch. ${toolsFree ? 'No tools.' : 'Inspect only as needed, read-only; no edits or state-changing commands.'}\nCorrect the previous plan: ${input.correction}${input.roleCatalogChanged ? '\nUpdated role catalog (replaces the previous catalog): ' + JSON.stringify(roles) : ''}`;
    return checkedTurn(text, input.sessionInstructions, toolsFree);
  }
  const brief = {
    title: input.title,
    goal: input.goalText,
    scope: structuredClone(input.scope),
    projectContext: input.projectContext || '',
    maxWorkers: input.maxWorkers,
    roles,
    workerRuntimes: input.pool.map(({ id, providerId, model, local }) => ({
      id,
      providerId,
      model,
      local,
    })),
    baseline: planningBaseline(input.baseline),
    ...(input.repairInstructions ? { environmentRepair: input.repairInstructions } : {}),
  };
  const scopeInstructions =
    input.scope.mode === 'strict'
      ? 'Scope is strict: assign nonempty paths contained by scope.plannedPaths. Protected paths are forbidden.'
      : 'Scope is advisory: adjacent edits are allowed and reviewed; use an empty list when discovery is needed. Protected paths are forbidden.';
  const instructions =
    (toolsFree
      ? `First, plan from Brief. No tools, inspection, edits, commands or agents. Discovery is for implementation; never invent findings.`
      : `First, inspect the repository read-only as needed and return the structured plan from Brief. Never edit files, execute state-changing commands or start agents. Report only observed findings; defer unresolved discovery to implementation.`) +
    `
Team: empty if small, else <=maxWorkers. Reuse roles; new roles reusable, not goal-specific. Exclude coordinator/reviewer/local_preview/delivery_pr/production_delivery. steps.owner=roleId or coordinator/reviewer.
Workers: nonoverlap planned paths; a directory if unknown. Assignment retains complete objective, inputs, result, criteria and constraints; null uses full goal/discovery.
Runtime: workerRuntimes or null/default. Honor fixed pins; explain preferred deviations. Full plan only. The service validates permissions/checks/review.` +
    '\n' +
    scopeInstructions;
  const text = `${instructions}\nBrief: ${JSON.stringify(brief)}${input.correction ? '\nCorrect the previous plan: ' + excerpt(input.correction, 1200) : ''}`;
  return checkedTurn(text, input.sessionInstructions, toolsFree);
}

/** Restrict the provider's team grammar to this run's frozen worker bound. */
export function planningOutputSchema(base: unknown, maxWorkers: number) {
  const schema = structuredClone(base);
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (
    !Number.isSafeInteger(maxWorkers) ||
    maxWorkers < 0 ||
    !record(schema) ||
    !record(schema.properties) ||
    !record(schema.properties.team) ||
    schema.properties.team.type !== 'array'
  )
    throw new DomainError(
      'INVALID_PLANNING_SCHEMA',
      'Planning requires a team array and a nonnegative worker bound.',
    );
  const team = schema.properties.team;
  const cap = team.maxItems;
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0))
    throw new DomainError(
      'INVALID_PLANNING_SCHEMA',
      'The planning schema has an invalid team bound.',
    );
  team.maxItems = typeof cap === 'number' ? Math.min(cap, maxWorkers) : maxWorkers;
  return schema;
}

function checkedTurn(text: string, sessionInstructions = '', toolsFree: boolean) {
  if (new TextEncoder().encode(sessionInstructions + text).length > MAX_PLANNING_INPUT_BYTES)
    throw new DomainError(
      'PLANNING_INPUT_TOO_LARGE',
      'The planning brief exceeds its bounded input envelope. Narrow the goal or project context; no goal criteria or scope constraints were discarded.',
    );
  return { text, ...(toolsFree ? { toolPolicy: 'none' as const } : {}) };
}
