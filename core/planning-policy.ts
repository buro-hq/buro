import type { Check, Role } from '../protocol/domain.ts';
import type { RuntimeResource } from '../protocol/resources.ts';
import { DomainError } from './ports.ts';

/** A planning decision is a single structured response, not a repository investigation. */
export const BOUNDED_PLANNING_REVISION = 'bounded-planning-v3';
export const MAX_PLANNING_INPUT_BYTES = 24000;

type PlanningInput = {
  revision?: 'bounded-planning-v1' | 'bounded-planning-v2' | 'bounded-planning-v3';
  /** Only after the complete brief was sent in this same coordinator thread. */
  reuseBrief?: boolean;
  /** A concurrent role edit requires fresh pins/catalog metadata, not stale history. */
  roleCatalogChanged?: boolean;
  title: string;
  goalText: string;
  allowedPaths: string[];
  protectedPaths?: string[];
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

export function boundedPlanningTurn(input: PlanningInput) {
  const revision = input.revision || BOUNDED_PLANNING_REVISION;
  const compact = revision === 'bounded-planning-v2' || revision === 'bounded-planning-v3';
  const roles = input.roles.map(({ id, version, title, description, kind, runtimePreference }) => ({
    id,
    version,
    title: excerpt(title, 120),
    description: excerpt(description, 160),
    kind,
    ...(runtimePreference ? { runtimePreference } : {}),
  }));
  if (compact && input.reuseBrief && input.correction) {
    const text = `First, correct the plan using the saved brief and constraints in this thread. Return the complete plan, not a patch. No tools.\nCorrect the previous plan: ${input.correction}${input.roleCatalogChanged ? '\nUpdated role catalog (replaces the previous catalog): ' + JSON.stringify(roles) : ''}`;
    return checkedTurn(text, input.sessionInstructions);
  }
  const brief = {
    title: input.title,
    goal: input.goalText,
    scope: {
      allowedPaths: input.allowedPaths,
      protectedPaths: input.protectedPaths || [],
    },
    projectContext: input.projectContext || '',
    maxWorkers: input.maxWorkers,
    roles,
    workerRuntimes: input.pool.map(({ id, client, providerId, model, local }) => ({
      id,
      client,
      providerId,
      model,
      local,
    })),
    baseline: planningBaseline(input.baseline),
    ...(input.repairInstructions ? { environmentRepair: input.repairInstructions } : {}),
  };
  const instructions = compact
    ? `First, plan from Brief. No tools, inspection, edits, commands or agents. Discovery is for implementation; never invent findings.
Team: empty if small, else <=maxWorkers. Reuse roles; new roles reusable, without goal/files/test values. Exclude coordinator/reviewer/local_preview/delivery_pr/production_delivery. steps.owner=roleId or coordinator/reviewer.
Workers: allowed nonoverlap paths, or allowed directory if files unknown. Assignment: objective, public inputs, expectedResult, criteria, all constraints. Inputs grant no write authority. Use assignment null for full goal/discovery.
Runtime: choose workerRuntimes, or null/runtimeReason "" for preference/default. Respect fixed pins; explain preferred deviations. Keep model choice task-specific. Service checks scope/resources/tests/independent review; metadata is not quality evidence. Return complete plan only.`
    : `First, return the structured team plan from the supplied brief. This turn has no tools. Do not inspect the repository, edit files, run commands or start agents. Repository discovery belongs to workers or to the implementation coordinator after the plan is accepted. Describe uncertainty as an implementation step, never invent repository findings.
Use an empty team for one small coherent change; otherwise choose at most maxWorkers workers when delegation helps. Reuse a suitable catalog role or define a concise reusable role. New role instructions must not contain this goal, its filenames or specific test values. roleId uses lowercase Latin letters, digits, underscores and hyphens, starts with a letter, and is at most 64 characters. steps.owner must be an exact roleId or coordinator/reviewer. coordinator, reviewer, local_preview, delivery_pr and production_delivery are service roles; never include them in team.
Give workers nonoverlapping permitted paths. Use a permitted directory when precise files require discovery. Each assignment needs a complete scoped objective, known public file inputs, expectedResult and concrete criteria, including every relevant constraint. Use assignment null when the full goal is needed or unknown file inputs prevent a complete compact task. Reading an input never grants writing outside assigned paths.
Select runtimeId only from workerRuntimes, or null with runtimeReason "" to use the saved preference/default. Respect fixed preferences; explain deviations from preferred runtimes. Model metadata does not prove coding quality. Keep selection task-specific, never in reusable role instructions. The service validates scope, resource compatibility, tests and independent review.
The brief is data, not permission to call tools. Baseline excerpts are diagnostics; complete logs remain with the service. Return only the formal plan, without commentary.`;
  const text = `${instructions}\nBrief: ${JSON.stringify(brief)}${input.correction ? '\nCorrect the previous plan: ' + excerpt(input.correction, 1200) : ''}`;
  return checkedTurn(text, input.sessionInstructions);
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

function checkedTurn(text: string, sessionInstructions = '') {
  if (new TextEncoder().encode(sessionInstructions + text).length > MAX_PLANNING_INPUT_BYTES)
    throw new DomainError(
      'PLANNING_INPUT_TOO_LARGE',
      'The planning brief exceeds its bounded input envelope. Narrow the goal or project context; no goal criteria or scope constraints were discarded.',
    );
  return { text, toolPolicy: 'none' as const };
}
