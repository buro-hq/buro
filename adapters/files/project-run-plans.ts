import { isDeepStrictEqual } from 'node:util';
import type { ProjectDocument } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import {
  validateRunPlan,
  plannerSessionGrant,
  validateRunPlanningInput,
  validateRunWorkerAssignment,
} from '../../core/project-run-plans.ts';
import type { RunPlan, RunWorkerAssignment } from '../../protocol/run-plan.ts';
import type { RunCurrent, RunAdmission } from '../../protocol/run-state.ts';
import { validateProjectRole } from '../../core/project-entities.ts';
import { documentAttemptContext } from './project-run-attempts.ts';
import type { RunAttemptContext } from '../../protocol/run-attempt.ts';
import { validateAssignmentResource } from '../../core/assignment-routing.ts';
import { planPathAllowed } from '../../core/execution-ports.ts';
import { withEnvironmentRepair } from '../../core/environment-repair.ts';

type PlanningDocument = ProjectDocument & {
  runPlans?: Record<string, RunPlan>;
  runPlanHeads?: Record<string, string>;
  runAssignments?: Record<string, RunWorkerAssignment>;
  runAssignmentHeads?: Record<string, Record<string, string>>;
  runHeads?: Record<string, RunCurrent>;
  runAdmissions?: Record<string, RunAdmission>;
};
type Access = { write<T>(action: () => T): T };
const invalid = () =>
  new DomainError('IMMUTABLE_RUN_PLAN', 'Saved run planning records cannot change.');
const conflict = () => new DomainError('CONFLICT', 'The run planning state changed.');
const initialPlanningInput = (admission: RunAdmission) =>
  validateRunPlanningInput({
    contextSource: 'initial-admission',
    title: admission.goal.title,
    goalText: admission.goalText,
    contextMaterials: admission.contextMaterials,
    checkIds: admission.checkIds,
    policy: admission.policy,
    resources: admission.resources,
    coordinator: {
      role: admission.roleSnapshots.find((role) => role.id === 'coordinator'),
      resource: admission.roleResources.coordinator,
    },
    workflow: admission.workflow,
    planningPolicy: admission.planningPolicy,
    repairEnvironment: admission.repairEnvironment,
  });
const attemptPlanningInput = (context: RunAttemptContext) =>
  validateRunPlanningInput({
    contextSource: 'continuation-attempt',
    title: context.goal.title,
    goalText: context.goalText,
    contextMaterials: context.contextMaterials,
    checkIds: context.checkIds,
    policy: context.policy,
    resources: context.resources,
    coordinator: {
      role: context.roleSnapshots.find((role) => role.id === 'coordinator'),
      resource: context.roleResources.coordinator,
    },
    workflow: context.workflow,
    planningPolicy: context.planningPolicy,
    repairEnvironment: context.repairEnvironment,
  });

export function createDocumentRunPlanRows(
  source: ProjectDocument,
  access: Access,
): Pick<
  RunTransactionStorage,
  | 'planningInput'
  | 'plan'
  | 'assignment'
  | 'planAssignments'
  | 'insertPlan'
  | 'insertAssignment'
  | 'sealPlanningSession'
> {
  const doc = source as PlanningDocument;
  const insertAssignment = (candidate: RunWorkerAssignment) =>
    access.write(() => {
      const assignment = validateRunWorkerAssignment(candidate);
      const run = doc.runs.find((value) => value.id === assignment.runId);
      if (
        !run ||
        Object.hasOwn(doc.runAssignments ?? {}, assignment.id) ||
        Object.hasOwn(doc.runAssignmentHeads?.[assignment.runId] ?? {}, assignment.role.id)
      )
        throw conflict();
      doc.runAssignments ??= {};
      doc.runAssignmentHeads ??= {};
      doc.runAssignmentHeads[assignment.runId] ??= {};
      Object.defineProperty(doc.runAssignments, assignment.id, {
        value: assignment,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      Object.defineProperty(doc.runAssignmentHeads[assignment.runId], assignment.role.id, {
        value: assignment.id,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      run.roleSnapshots = [...(run.roleSnapshots ?? []), structuredClone(assignment.role)];
      run.roleOrigins = { ...run.roleOrigins, [assignment.role.id]: assignment.origin };
      run.roleAssignments = { ...run.roleAssignments, [assignment.role.id]: [...assignment.paths] };
      run.assignmentResources = {
        ...run.assignmentResources,
        [assignment.role.id]: structuredClone(assignment.resource),
      };
      run.workerTasks = {
        ...run.workerTasks,
        ...(assignment.task ? { [assignment.role.id]: structuredClone(assignment.task) } : {}),
      };
    });
  return {
    insertAssignment,
    planningInput: (runId) => {
      const run = doc.runs.find((run) => run.id === runId);
      if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
      const head = doc.runHeads?.[runId];
      if (!head) throw invalid();
      const context = documentAttemptContext(doc, head.attemptId);
      const input = validateRunPlanningInput({
        contextSource: context.continuation ? 'continuation-attempt' : 'initial-admission',
        title: run.title,
        goalText: run.goalText,
        contextMaterials: run.contextMaterials ?? [],
        checkIds: run.checkIds ?? [],
        policy: run.executionPolicySnapshot,
        resources: run.resources,
        coordinator: {
          role: run.roleSnapshots?.find((role) => role.id === 'coordinator'),
          resource: run.roleResources?.coordinator,
        },
        workflow: run.workflow,
        planningPolicy: run.planningPolicy,
        repairEnvironment: !!run.repairEnvironment,
        ...(run.planningPolicy?.strategy === 'read-only-inspection' &&
        run.threadId &&
        run.coordinatorSession
          ? {
              readOnlyPlanner: {
                threadId: run.threadId,
                sessionId: run.coordinatorSession.id,
                sessionGrant: plannerSessionGrant(run.coordinatorSession),
              },
            }
          : {}),
      });
      if (!context.continuation) {
        const admissionId = doc.runHeads?.[runId]?.admissionId;
        const admission = admissionId ? doc.runAdmissions?.[admissionId] : undefined;
        if (!admission || admission.runId !== runId) throw invalid();
        const expected = initialPlanningInput(admission);
        const { readOnlyPlanner: _planner, ...actual } = input;
        if (!isDeepStrictEqual(actual, expected)) throw invalid();
      } else {
        const { readOnlyPlanner: _planner, ...actual } = input;
        if (!isDeepStrictEqual(actual, attemptPlanningInput(context))) throw invalid();
      }
      return input;
    },
    plan: (runId) => {
      const id = doc.runPlanHeads?.[runId];
      if (id === undefined) return undefined;
      const saved = doc.runPlans?.[id];
      if (!saved) throw invalid();
      return validateRunPlan(saved);
    },
    assignment: (runId, roleId) => {
      const id = doc.runAssignmentHeads?.[runId]?.[roleId];
      const saved = id === undefined ? undefined : doc.runAssignments?.[id];
      return saved === undefined ? undefined : validateRunWorkerAssignment(saved);
    },
    planAssignments: (runId) =>
      Object.values(doc.runAssignmentHeads?.[runId] ?? {}).map((id) => {
        const saved = doc.runAssignments?.[id];
        if (!saved) throw invalid();
        return validateRunWorkerAssignment(saved);
      }),
    insertPlan: (candidate, candidates) =>
      access.write(() => {
        const plan = validateRunPlan(candidate),
          run = doc.runs.find((run) => run.id === plan.runId);
        if (
          !run ||
          Object.hasOwn(doc.runPlans ?? {}, plan.id) ||
          Object.hasOwn(doc.runPlanHeads ?? {}, plan.runId)
        )
          throw conflict();
        if (Object.keys(doc.runAssignmentHeads?.[plan.runId] ?? {}).length) throw conflict();
        const assignments = candidates.map(validateRunWorkerAssignment);
        for (const assignment of assignments) {
          if (
            assignment.planId !== plan.id ||
            assignment.runId !== plan.runId ||
            assignment.admissionId !== plan.admissionId ||
            assignment.attemptId !== plan.attemptId
          )
            throw invalid();
        }
        doc.runPlans ??= {};
        doc.runPlanHeads ??= {};
        Object.defineProperty(doc.runPlans, plan.id, {
          value: plan,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        Object.defineProperty(doc.runPlanHeads, plan.runId, {
          value: plan.id,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        run.plan = structuredClone(plan.steps);
        run.planSavedAt = plan.createdAt;
        doc.runAssignmentHeads ??= {};
        doc.runAssignmentHeads[plan.runId] = {};
        run.roleOrigins = {};
        run.roleAssignments = {};
        run.assignmentResources = {};
        run.workerTasks = {};
        for (const assignment of assignments) insertAssignment(assignment);
      }),
    sealPlanningSession: (runId, planner) =>
      access.write(() => {
        const run = doc.runs.find((run) => run.id === runId);
        if (
          !run ||
          run.threadId !== planner.threadId ||
          run.coordinatorSession?.id !== planner.sessionId ||
          !isDeepStrictEqual(plannerSessionGrant(run.coordinatorSession), planner.sessionGrant) ||
          run.planningPolicy?.strategy !== 'read-only-inspection'
        )
          throw conflict();
        run.planningSession = run.coordinatorSession;
        run.coordinatorSession = undefined;
        run.threadId = '';
      }),
  };
}

/** Original decisions stay immutable; task refinements and continuation context retain their later owners. */
export function validateDocumentRunPlans(previous: ProjectDocument, next: ProjectDocument) {
  const before = previous as PlanningDocument,
    after = next as PlanningDocument;
  for (const [id, original] of Object.entries(before.runPlans ?? {}))
    if (
      !after.runPlans?.[id] ||
      !isDeepStrictEqual(validateRunPlan(original), validateRunPlan(after.runPlans[id]))
    )
      throw invalid();
  for (const [id, original] of Object.entries(before.runAssignments ?? {}))
    if (!after.runAssignments?.[id] || !isDeepStrictEqual(original, after.runAssignments[id]))
      throw invalid();
  for (const [runId, planId] of Object.entries(before.runPlanHeads ?? {}))
    if (after.runPlanHeads?.[runId] !== planId) throw invalid();
  for (const [runId, heads] of Object.entries(before.runAssignmentHeads ?? {}))
    for (const [roleId, id] of Object.entries(heads))
      if (after.runAssignmentHeads?.[runId]?.[roleId] !== id) throw invalid();
  for (const [id, value] of Object.entries(after.runPlans ?? {})) {
    const plan = validateRunPlan(value),
      run = after.runs.find((run) => run.id === plan.runId),
      head = after.runHeads?.[plan.runId];
    if (
      plan.id !== id ||
      after.runPlanHeads?.[plan.runId] !== id ||
      !run ||
      !head ||
      head.admissionId !== plan.admissionId ||
      (head.attemptId !== plan.attemptId &&
        (documentAttemptContext(after, head.attemptId).inheritedPlanId !== id ||
          documentAttemptContext(after, head.attemptId).planOriginAttemptId !== plan.attemptId)) ||
      !isDeepStrictEqual(run.plan, plan.steps) ||
      run.planSavedAt !== plan.createdAt
    )
      throw invalid();
    const expected =
      plan.context.contextSource === 'initial-admission'
        ? after.runAdmissions?.[plan.admissionId] &&
          initialPlanningInput(after.runAdmissions[plan.admissionId])
        : attemptPlanningInput(documentAttemptContext(after, plan.attemptId));
    const { readOnlyPlanner: _planner, ...captured } = plan.context;
    if (!expected || !isDeepStrictEqual(captured, expected)) throw invalid();
    if (
      plan.readOnlyPlanner &&
      (!run.planningSession ||
        !isDeepStrictEqual(
          plannerSessionGrant(run.planningSession),
          plan.readOnlyPlanner.sessionGrant,
        ) ||
        run.planningSession.id !== plan.readOnlyPlanner.sessionId ||
        run.threadId === plan.readOnlyPlanner.threadId ||
        run.coordinatorSession?.id === plan.readOnlyPlanner.sessionId)
    )
      throw invalid();
  }
  for (const [id, value] of Object.entries(after.runAssignments ?? {})) {
    const assignment = validateRunWorkerAssignment(value);
    const head = after.runHeads?.[assignment.runId];
    const context = documentAttemptContext(after, assignment.attemptId);
    const scope = withEnvironmentRepair(context.policy, context.repairEnvironment).scope;
    if (
      (scope.mode === 'strict' && !assignment.paths.length) ||
      assignment.paths.some((path) => !planPathAllowed(path, scope))
    )
      throw invalid();
    validateAssignmentResource(
      context.resources,
      assignment.role,
      assignment.resource,
      scope.mode === 'strict' ? { strictPlannedWrites: true } : {},
    );
    const role = after.roleVersions.find(
      (role) => role.id === assignment.role.id && role.version === assignment.role.version,
    );
    if (
      assignment.id !== id ||
      !head ||
      head.admissionId !== assignment.admissionId ||
      context.runId !== assignment.runId ||
      context.admissionId !== assignment.admissionId ||
      after.runAssignmentHeads?.[assignment.runId]?.[assignment.role.id] !== id ||
      !role ||
      !isDeepStrictEqual(validateProjectRole(role), assignment.role)
    )
      throw invalid();
    if (
      assignment.planId &&
      (after.runPlans?.[assignment.planId]?.runId !== assignment.runId ||
        after.runPlans[assignment.planId].attemptId !== assignment.attemptId)
    )
      throw invalid();
  }
  for (const [runId, heads] of Object.entries(after.runAssignmentHeads ?? {})) {
    const run = after.runs.find((run) => run.id === runId),
      head = after.runHeads?.[runId];
    if (!run || !head) throw invalid();
    const inherited = documentAttemptContext(after, head.attemptId).inheritedAssignments;
    const assignments = Object.entries(heads).map(([roleId, id]) => {
      const value = after.runAssignments?.[id];
      if (
        !value ||
        value.role.id !== roleId ||
        value.runId !== runId ||
        (value.attemptId !== head.attemptId && inherited?.[roleId]?.id !== id)
      )
        throw invalid();
      return validateRunWorkerAssignment(value);
    });
    for (const [field, expected] of [
      ['roleAssignments', Object.fromEntries(assignments.map((a) => [a.role.id, a.paths]))],
      ['roleOrigins', Object.fromEntries(assignments.map((a) => [a.role.id, a.origin]))],
      ['assignmentResources', Object.fromEntries(assignments.map((a) => [a.role.id, a.resource]))],
    ] as const)
      if (!isDeepStrictEqual(run[field], expected)) throw invalid();
    for (const assignment of assignments)
      if (
        !isDeepStrictEqual(
          run.roleSnapshots?.find((role) => role.id === assignment.role.id),
          assignment.role,
        )
      )
        throw invalid();
  }
  for (const [runId, planId] of Object.entries(after.runPlanHeads ?? {}))
    if (after.runPlans?.[planId]?.runId !== runId) throw invalid();
  for (const runId of Object.keys(after.runHeads ?? {})) {
    const run = after.runs.find((run) => run.id === runId);
    if (run?.planSavedAt !== undefined && !after.runPlanHeads?.[runId]) throw invalid();
    if (
      (run?.roleAssignments !== undefined || run?.assignmentResources !== undefined) &&
      !after.runAssignmentHeads?.[runId]
    )
      throw invalid();
  }
}
