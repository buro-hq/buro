import { isDeepStrictEqual } from 'node:util';
import type { ProjectDocument } from '../../core/ports.ts';
import { DomainError } from '../../core/ports.ts';
import type { RunTransactionStorage } from '../../core/project-runs.ts';
import {
  validateRunDelegationContext,
  validateRunWorkerAssignment,
} from '../../core/project-run-delegations.ts';
import type { RunWorkerAssignment } from '../../protocol/run-delegation.ts';
import type { RunCurrent, RunAdmission } from '../../protocol/run-state.ts';
import { validateProjectRole } from '../../core/project-entities.ts';
import { documentAttemptContext } from './project-run-attempts.ts';
import type { RunAttemptContext } from '../../protocol/run-attempt.ts';
import { validateAssignmentResource } from '../../core/assignment-routing.ts';
import { planPathAllowed } from '../../core/execution-ports.ts';
import { withEnvironmentRepair } from '../../core/environment-repair.ts';

type DelegationDocument = ProjectDocument & {
  runAssignments?: Record<string, RunWorkerAssignment>;
  runAssignmentHeads?: Record<string, Record<string, string>>;
  runHeads?: Record<string, RunCurrent>;
  runAdmissions?: Record<string, RunAdmission>;
};
type Access = { write<T>(action: () => T): T };
const invalid = () =>
  new DomainError('IMMUTABLE_RUN_ASSIGNMENT', 'Saved run delegation records cannot change.');
const conflict = () => new DomainError('CONFLICT', 'The delegation state changed.');
const initialDelegationContext = (admission: RunAdmission) =>
  validateRunDelegationContext({
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
    repairEnvironment: admission.repairEnvironment,
  });
const attemptDelegationContext = (context: RunAttemptContext) =>
  validateRunDelegationContext({
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
    repairEnvironment: context.repairEnvironment,
  });

export function createDocumentRunDelegationRows(
  source: ProjectDocument,
  access: Access,
): Pick<
  RunTransactionStorage,
  'delegationContext' | 'assignment' | 'assignments' | 'insertAssignment'
> {
  const doc = source as DelegationDocument;
  const insertAssignment = (candidate: RunWorkerAssignment) =>
    access.write(() => {
      const assignment = validateRunWorkerAssignment(candidate);
      const run = doc.runs.find((value) => value.id === assignment.runId);
      if (
        !run ||
        Object.hasOwn(doc.runAssignments ?? {}, assignment.id) ||
        doc.runAssignmentHeads?.[assignment.runId]?.[assignment.role.id] !==
          assignment.previousAssignmentId
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
      doc.runAssignmentHeads[assignment.runId] = {
        ...doc.runAssignmentHeads[assignment.runId],
        [assignment.role.id]: assignment.id,
      };
      run.roleSnapshots = [
        ...(run.roleSnapshots ?? []).filter((role) => role.id !== assignment.role.id),
        structuredClone(assignment.role),
      ];
      run.roleOrigins = { ...run.roleOrigins, [assignment.role.id]: assignment.origin };
      run.roleAssignments = { ...run.roleAssignments, [assignment.role.id]: [...assignment.paths] };
      run.assignmentResources = {
        ...run.assignmentResources,
        [assignment.role.id]: structuredClone(assignment.resource),
      };
      run.workerTasks = { ...run.workerTasks };
      if (assignment.task) run.workerTasks[assignment.role.id] = structuredClone(assignment.task);
      else delete run.workerTasks[assignment.role.id];
    });
  return {
    insertAssignment,
    delegationContext: (runId) => {
      const run = doc.runs.find((run) => run.id === runId);
      if (!run) throw new DomainError('NOT_FOUND', 'Run not found.');
      const head = doc.runHeads?.[runId];
      if (!head) throw invalid();
      const context = documentAttemptContext(doc, head.attemptId);
      const input = validateRunDelegationContext({
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
        repairEnvironment: !!run.repairEnvironment,
      });
      if (!context.continuation) {
        const admissionId = doc.runHeads?.[runId]?.admissionId;
        const admission = admissionId ? doc.runAdmissions?.[admissionId] : undefined;
        if (!admission || admission.runId !== runId) throw invalid();
        const expected = initialDelegationContext(admission);
        if (!isDeepStrictEqual(input, expected)) throw invalid();
      } else {
        if (!isDeepStrictEqual(input, attemptDelegationContext(context))) throw invalid();
      }
      return input;
    },
    assignment: (runId, roleId) => {
      const id = doc.runAssignmentHeads?.[runId]?.[roleId];
      const saved = id === undefined ? undefined : doc.runAssignments?.[id];
      return saved === undefined ? undefined : validateRunWorkerAssignment(saved);
    },
    assignments: (runId) =>
      Object.values(doc.runAssignmentHeads?.[runId] ?? {}).map((id) => {
        const saved = doc.runAssignments?.[id];
        if (!saved) throw invalid();
        return validateRunWorkerAssignment(saved);
      }),
  };
}

/** Original decisions stay immutable; task refinements and continuation context retain their later owners. */
export function validateDocumentRunDelegations(previous: ProjectDocument, next: ProjectDocument) {
  const before = previous as DelegationDocument,
    after = next as DelegationDocument;
  for (const [id, original] of Object.entries(before.runAssignments ?? {}))
    if (!after.runAssignments?.[id] || !isDeepStrictEqual(original, after.runAssignments[id]))
      throw invalid();
  for (const [runId, heads] of Object.entries(before.runAssignmentHeads ?? {}))
    for (const [roleId, id] of Object.entries(heads)) {
      let next = after.runAssignmentHeads?.[runId]?.[roleId];
      const seen = new Set<string>();
      while (next && next !== id && !seen.has(next)) {
        seen.add(next);
        next = after.runAssignments?.[next]?.previousAssignmentId;
      }
      if (next !== id) throw invalid();
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
      !role ||
      !isDeepStrictEqual(validateProjectRole(role), assignment.role)
    )
      throw invalid();
    if (assignment.previousAssignmentId) {
      const prior = after.runAssignments?.[assignment.previousAssignmentId];
      if (
        !prior ||
        prior.id === id ||
        prior.runId !== assignment.runId ||
        prior.admissionId !== assignment.admissionId ||
        !isDeepStrictEqual(prior.role, assignment.role)
      )
        throw invalid();
    }
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
  const rows = createDocumentRunDelegationRows(after, {
    write() {
      throw invalid();
    },
  });
  for (const runId of Object.keys(after.runHeads ?? {})) {
    rows.delegationContext(runId);
    const run = after.runs.find((run) => run.id === runId);
    if (
      (run?.roleAssignments !== undefined || run?.assignmentResources !== undefined) &&
      !after.runAssignmentHeads?.[runId]
    )
      throw invalid();
  }
}
