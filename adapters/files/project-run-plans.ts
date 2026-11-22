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

type PlanningDocument = ProjectDocument & {
  runPlans?: Record<string, RunPlan>;
  runPlanHeads?: Record<string, string>;
  runAssignments?: Record<string, Record<string, RunWorkerAssignment>>;
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
  'planningInput' | 'plan' | 'assignment' | 'planAssignments' | 'insertPlan' | 'sealPlanningSession'
> {
  const doc = source as PlanningDocument;
  return {
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
      const planId = doc.runPlanHeads?.[runId];
      if (planId === undefined) return undefined;
      const saved = doc.runAssignments?.[planId]?.[roleId];
      return saved === undefined ? undefined : validateRunWorkerAssignment(saved);
    },
    planAssignments: (runId) => {
      const id = doc.runPlanHeads?.[runId];
      return id === undefined
        ? []
        : Object.values(doc.runAssignments?.[id] ?? {}).map(validateRunWorkerAssignment);
    },
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
        const assignments = candidates.map(validateRunWorkerAssignment);
        const rows: Record<string, RunWorkerAssignment> = {};
        for (const assignment of assignments) {
          if (
            assignment.planId !== plan.id ||
            assignment.runId !== plan.runId ||
            assignment.admissionId !== plan.admissionId ||
            assignment.attemptId !== plan.attemptId ||
            Object.hasOwn(rows, assignment.role.id)
          )
            throw invalid();
          Object.defineProperty(rows, assignment.role.id, {
            value: assignment,
            enumerable: true,
            writable: false,
            configurable: false,
          });
        }
        doc.runPlans ??= {};
        doc.runPlanHeads ??= {};
        doc.runAssignments ??= {};
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
        Object.defineProperty(doc.runAssignments, plan.id, {
          value: rows,
          enumerable: true,
          writable: false,
          configurable: false,
        });
        run.plan = structuredClone(plan.steps);
        run.planSavedAt = plan.createdAt;
        run.roleSnapshots = [
          ...(run.roleSnapshots ?? []).filter((role) =>
            ['coordinator', 'reviewer'].includes(role.id),
          ),
          ...assignments.map((assignment) => structuredClone(assignment.role)),
        ];
        run.roleOrigins = Object.fromEntries(
          assignments.map((assignment) => [assignment.role.id, assignment.origin]),
        );
        run.roleAssignments = Object.fromEntries(
          assignments.map((assignment) => [assignment.role.id, [...assignment.paths]]),
        );
        run.workerTasks = Object.fromEntries(
          assignments
            .filter((assignment) => assignment.task !== undefined)
            .map((assignment) => [assignment.role.id, structuredClone(assignment.task!)]),
        );
        run.assignmentResources = Object.fromEntries(
          assignments.map((assignment) => [
            assignment.role.id,
            structuredClone(assignment.resource),
          ]),
        );
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
  for (const [id, original] of Object.entries(before.runPlans ?? {})) {
    const saved = after.runPlans?.[id];
    if (!saved || !isDeepStrictEqual(validateRunPlan(original), validateRunPlan(saved)))
      throw invalid();
  }
  for (const [id, original] of Object.entries(before.runAssignments ?? {})) {
    const saved = after.runAssignments?.[id];
    if (!saved || !isDeepStrictEqual(original, saved)) throw invalid();
  }
  for (const [runId, planId] of Object.entries(before.runPlanHeads ?? {})) {
    if (after.runPlanHeads?.[runId] !== planId) throw invalid();
  }
  for (const [id, value] of Object.entries(after.runPlans ?? {})) {
    const plan = validateRunPlan(value);
    const run = after.runs.find((run) => run.id === plan.runId);
    const head = after.runHeads?.[plan.runId];
    if (
      plan.id !== id ||
      after.runPlanHeads?.[plan.runId] !== id ||
      !run ||
      !after.runAssignments?.[id] ||
      !head ||
      head.admissionId !== plan.admissionId ||
      (head.attemptId !== plan.attemptId &&
        (documentAttemptContext(after, head.attemptId).inheritedPlanId !== id ||
          documentAttemptContext(after, head.attemptId).planOriginAttemptId !== plan.attemptId)) ||
      !isDeepStrictEqual(run.plan, plan.steps) ||
      run.planSavedAt !== plan.createdAt
    )
      throw invalid();
    if (plan.context.contextSource === 'initial-admission') {
      const admission = after.runAdmissions?.[plan.admissionId];
      const { readOnlyPlanner: _planner, ...captured } = plan.context;
      if (
        !admission ||
        admission.runId !== plan.runId ||
        !isDeepStrictEqual(captured, initialPlanningInput(admission))
      )
        throw invalid();
    } else if (plan.context.contextSource === 'continuation-attempt') {
      const { readOnlyPlanner: _planner, ...captured } = plan.context;
      if (
        !isDeepStrictEqual(
          captured,
          attemptPlanningInput(documentAttemptContext(after, plan.attemptId)),
        )
      )
        throw invalid();
    } else if (!run.continuation) throw invalid();
    const assignments = Object.entries(after.runAssignments[id]).map(([roleId, value]) => {
      const assignment = validateRunWorkerAssignment(value);
      if (
        assignment.planId !== id ||
        assignment.runId !== plan.runId ||
        assignment.admissionId !== plan.admissionId ||
        assignment.attemptId !== plan.attemptId ||
        assignment.role.id !== roleId
      )
        throw invalid();
      return assignment;
    });
    if (
      !isDeepStrictEqual(
        run.roleAssignments,
        Object.fromEntries(assignments.map((assignment) => [assignment.role.id, assignment.paths])),
      ) ||
      !isDeepStrictEqual(
        run.roleOrigins,
        Object.fromEntries(
          assignments.map((assignment) => [assignment.role.id, assignment.origin]),
        ),
      ) ||
      !isDeepStrictEqual(
        run.assignmentResources,
        Object.fromEntries(
          assignments.map((assignment) => [assignment.role.id, assignment.resource]),
        ),
      )
    )
      throw invalid();
    for (const assignment of assignments) {
      const role = run.roleSnapshots?.find((role) => role.id === assignment.role.id);
      const savedRole = after.roleVersions.find(
        (role) => role.id === assignment.role.id && role.version === assignment.role.version,
      );
      if (
        !isDeepStrictEqual(role, assignment.role) ||
        !savedRole ||
        !isDeepStrictEqual(validateProjectRole(savedRole), assignment.role)
      )
        throw invalid();
    }
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
  for (const [runId, planId] of Object.entries(after.runPlanHeads ?? {})) {
    if (after.runPlans?.[planId]?.runId !== runId) throw invalid();
  }
  for (const planId of Object.keys(after.runAssignments ?? {})) {
    if (!after.runPlans?.[planId]) throw invalid();
  }
  for (const runId of Object.keys(after.runHeads ?? {})) {
    const run = after.runs.find((run) => run.id === runId);
    if (
      run &&
      (run.planSavedAt !== undefined ||
        run.plan.length > 0 ||
        run.roleAssignments !== undefined ||
        run.assignmentResources !== undefined) &&
      !after.runPlanHeads?.[runId]
    )
      throw invalid();
  }
}
