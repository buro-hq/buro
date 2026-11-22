import { z } from 'zod';
import { RoleSchema as role, WorkflowIdentitySchema } from './workflow-roles.ts';
import { VerificationViewSchema, VerificationEvidenceSchema } from './verification.ts';
import { ManagedRunBudgetSummarySchema, ManagedBudgetErrorCodeSchema } from './run-budget.ts';
import {
  roleIdPattern,
  type DomainEvent,
  type Snapshot,
  type ServiceInfo,
  type ResourceConfigurationChange,
} from './domain.ts';
import { ConnectionInputSchema, ProjectProfileSchema } from './projects.ts';
import {
  DeliverySchema,
  PreviewSchema,
  ResearchSchema,
  ResearchResultSchema,
  GoalOutcomeSchema,
} from './operations.ts';
import { ContextMaterialSchema } from './context.ts';
import { PendingRunTurnSchema, RunReconciliationSchema } from './reconciliation.ts';
import { ExecutionPolicySchema } from './execution-policy.ts';
import { ScopeObservationSchema } from './work-scope.ts';
import { PlanningPolicySchema, planningPolicyMatchesResource } from './planning-policy.ts';
import { EffectivePolicySchema, RunStopSchema } from './autonomy.ts';
export { PlanningPolicySchema } from './planning-policy.ts';
import {
  WorkerTaskSchema,
  WorkerEnvelopeSchema,
  WorkerKnownFailureSchema,
  WorkerReplanSchema,
} from './worker-tasks.ts';
import {
  ResourceSnapshotSchema,
  RuntimePreferenceSchema,
  AssignmentResourceSchema,
  AssignmentSelectionSchema,
  ResourceConnectionSchema,
  ResourceSetupInputSchema,
  SavedOperationContextSchema,
} from './resources.ts';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const ProjectSchema = z.strictObject({
  id,
  name: z.string().min(1),
  root: z.string().min(1),
  managed: z.boolean().optional(),
  dataDirectory: z.string().optional(),
});
const project = z.strictObject({ projectId: id });
const text = (max = 16000) => z.string().trim().min(1).max(max);
export const RoleInputSchema = z.strictObject({
  projectId: id,
  id: z.string().regex(roleIdPattern),
  title: text(120),
  description: text(1000),
  instructions: text(),
  kind: z.enum(['implementation', 'testing', 'review', 'coordination', 'general']),
  model: z.string().trim().min(1).max(120).optional(),
  runtimePreference: RuntimePreferenceSchema.optional(),
  expectedVersion: z.number().int().nonnegative(),
});
export const GoalInputSchema = z.strictObject({
  projectId: id,
  title: text(200),
  body: text(),
  criteria: z.string().max(8000).default(''),
  repairEnvironment: z.boolean().optional(),
  parentRunId: id.optional(),
  outcome: GoalOutcomeSchema.optional(),
  materialIds: z.array(id).max(32).optional(),
});
export const CommandSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('service.info'), params: z.strictObject({}) }),
  z.strictObject({
    method: z.literal('resources.list'),
    params: z.strictObject({ projectId: id.optional() }),
  }),
  z.strictObject({ method: z.literal('resources.init'), params: z.strictObject({}) }),
  z.strictObject({
    method: z.literal('resources.models'),
    params: z.strictObject({ connectionId: id }),
  }),
  z.strictObject({
    method: z.literal('resources.probe'),
    params: z.strictObject({ runtimeId: id }),
  }),
  z.strictObject({ method: z.literal('resources.use'), params: z.strictObject({ profileId: id }) }),
  z.strictObject({
    method: z.literal('resources.connection.save'),
    params: z.strictObject({
      connection: ResourceConnectionSchema,
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
  }),
  z.strictObject({
    method: z.literal('resources.setup.save'),
    params: ResourceSetupInputSchema,
  }),
  z.strictObject({
    method: z.literal('filesystem.list'),
    params: z.strictObject({
      path: z.string().max(4000).optional(),
      projectId: id.optional(),
      restricted: z.boolean().optional(),
      showHidden: z.boolean().optional(),
      query: z.string().max(200).optional(),
    }),
  }),
  z.strictObject({ method: z.literal('context.list'), params: project }),
  z.strictObject({
    method: z.literal('context.import'),
    params: z.strictObject({
      projectId: id,
      scope: z.enum(['project', 'goal']),
      paths: z.array(text(4000)).min(1).max(32).optional(),
      upload: z
        .strictObject({
          name: text(240),
          base64: z
            .string()
            .max(12 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('context.remove'),
    params: z.strictObject({ projectId: id, materialId: id }),
  }),
  z.strictObject({ method: z.literal('project.list'), params: z.strictObject({}) }),
  z.strictObject({
    method: z.literal('project.inspect'),
    params: z.strictObject({ root: text(4000) }),
  }),
  z.strictObject({ method: z.literal('project.connect'), params: ConnectionInputSchema }),
  z.strictObject({ method: z.literal('project.info'), params: project }),
  z.strictObject({ method: z.literal('project.research'), params: project }),
  z.strictObject({
    method: z.literal('project.research.apply'),
    params: z.strictObject({
      projectId: id,
      researchId: id,
      expectedRevision: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({ method: z.literal('project.research.status'), params: project }),
  z.strictObject({ method: z.literal('project.research.cancel'), params: project }),
  z.strictObject({
    method: z.literal('run.preview.start'),
    params: z.strictObject({ projectId: id, runId: id }),
  }),
  z.strictObject({
    method: z.literal('run.preview.stop'),
    params: z.strictObject({ projectId: id, runId: id }),
  }),
  z.strictObject({
    method: z.literal('run.preview.status'),
    params: z.strictObject({ projectId: id, runId: id }),
  }),
  z.strictObject({
    method: z.literal('run.preview.restart'),
    params: z.strictObject({ projectId: id, runId: id }),
  }),
  z.strictObject({
    method: z.literal('run.deliver'),
    params: z.strictObject({
      projectId: id,
      runId: id,
      expectedCommit: z.string().regex(/^[a-f0-9]{40}$/),
      confirmed: z.boolean().default(false),
      redeploy: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('project.configure'),
    params: z.strictObject({
      projectId: id,
      profile: ProjectProfileSchema,
      expectedRevision: z.number().int().nonnegative(),
      researchId: id.optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('project.verify'),
    params: z.strictObject({ projectId: id, checkIds: z.array(id).min(1).max(8) }),
  }),
  z.strictObject({
    method: z.literal('run.apply'),
    params: z.strictObject({
      projectId: id,
      runId: id,
      expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
      expectedBranch: text(300),
    }),
  }),
  z.strictObject({ method: z.literal('project.snapshot'), params: project }),
  z.strictObject({ method: z.literal('project.storage'), params: project }),
  z.strictObject({ method: z.literal('project.storage.gc'), params: project }),
  z.strictObject({ method: z.literal('goal.create'), params: GoalInputSchema }),
  z.strictObject({
    method: z.literal('goal.update'),
    params: GoalInputSchema.extend({ id, expectedRevision: z.number().int().positive() }),
  }),
  z.strictObject({
    method: z.literal('run.resume'),
    params: z.strictObject({
      projectId: id,
      runId: id,
      mode: z.enum(['repair', 'recheck']),
      instructions: z.string().max(16000).default(''),
      checkIds: z.array(id).min(1).max(8).optional(),
      useCurrentProfile: z.boolean().default(false),
    }),
  }),
  z.strictObject({
    method: z.literal('goal.delete'),
    params: z.strictObject({ projectId: id, id }),
  }),
  z.strictObject({ method: z.literal('role.save'), params: RoleInputSchema }),
  z.strictObject({
    method: z.literal('run.start'),
    params: z.strictObject({
      projectId: id,
      goalId: id,
      checkIds: z.array(id).min(1).max(8).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('run.cancel'),
    params: z.strictObject({ projectId: id, runId: id }),
  }),
  z.strictObject({
    method: z.literal('events.subscribe'),
    params: z.strictObject({ projectId: id, after: z.number().int().nonnegative() }),
  }),
]);
export const RequestSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal('request'),
  id,
  command: CommandSchema,
});
export type Request = z.infer<typeof RequestSchema>;
export type ClientCommand = z.infer<typeof CommandSchema>;
export type Response =
  | { version: 1; type: 'response'; id: string; ok: true; result: unknown }
  | {
      version: 1;
      type: 'response';
      id: string;
      ok: false;
      error: { code: string; message: string };
    };
export type ServerMessage =
  | Response
  | { version: 1; type: 'service.change'; change: ResourceConfigurationChange }
  | { version: 1; type: 'event'; event: DomainEvent }
  | { version: 1; type: 'hello'; capabilities: string[] };

export const ResourceConfigurationChangeSchema = z.strictObject({
  topic: z.literal('resources'),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  appliesTo: z.enum(['new-runs', 'service-restart']),
});

export const GoalSchema = z.object({
  materialIds: z.array(z.string()).optional(),
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  body: z.string(),
  criteria: z.string(),
  status: z.enum(['draft', 'running', 'completed', 'failed']),
  createdAt: z.string(),
  revision: z.number().int().positive().optional(),
  repairEnvironment: z.boolean().optional(),
  parentRunId: z.string().optional(),
  outcome: GoalOutcomeSchema.optional(),
  runId: z.string().optional(),
});
const goal = GoalSchema;
/** Independent current/grant records. None of these schemas accepts a whole legacy Run. */
export const RunCurrentSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  goalId: z.string().min(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  admissionId: z.string().min(1),
  attemptId: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  status: z.enum([
    'queued',
    'running',
    'canceling',
    'completed',
    'failed',
    'interrupted',
    'needs-attention',
  ]),
  phase: z.enum([
    'preparing',
    'queued',
    'planning',
    'implementation',
    'checking',
    'review',
    'repair',
    'done',
  ]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().optional(),
  cancelRequested: z.boolean(),
});
export const RunAdmissionSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  createdAt: z.string().min(1),
  goal: GoalSchema.strict(),
  goalText: z.string(),
  policy: ExecutionPolicySchema.extend({
    turnTimeoutMs: z.number().int().positive(),
    context: z.string().optional(),
    profile: ProjectProfileSchema.optional(),
  }),
  resources: ResourceSnapshotSchema,
  workflow: WorkflowIdentitySchema,
  roleSnapshots: z.array(role.strict()),
  roleResources: z.record(z.string(), AssignmentResourceSchema),
  planningPolicy: PlanningPolicySchema,
  contextMaterials: z.array(ContextMaterialSchema.strict()),
  checkIds: z.array(z.string().min(1)),
  repairEnvironment: z.boolean(),
  timePolicy: z.strictObject({
    kind: z.literal('inactivity'),
    idleTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  outcome: GoalOutcomeSchema,
  parentRunId: z.string().optional(),
});
export const RunAttemptSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  runId: z.string().min(1),
  admissionId: z.string().min(1),
  ordinal: z.literal(1),
  reason: z.literal('initial'),
  createdAt: z.string().min(1),
});
export const RunTimelineEntrySchema = z.strictObject({
  runId: z.string().min(1),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.string().min(1),
  type: z.string().min(1),
  text: z.string().optional(),
  threadId: z.string().optional(),
  commandId: z.string().optional(),
  durationMs: z.number().optional(),
});
const check = z.object({
  name: z.string(),
  passed: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  command: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().optional(),
});
const checks = z.object({
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  results: z.array(check),
});
export const ProjectVerificationSchema = z.object({
  id: z.string(),
  profileRevision: z.number(),
  createdAt: z.string(),
  workspace: z.string(),
  base: z.string(),
  passed: z.number(),
  total: z.number(),
  results: z.array(check),
});
const verification = ProjectVerificationSchema;
export const ResearchAcknowledgementSchema = z.strictObject({
  id: z.string().min(1),
  reviewedProfileRevision: z.number().int().positive(),
  appliedProfileRevision: z.number().int().positive().optional(),
});
/** Bounded settings input: the research body cannot carry history, grants or model resources. */
export const ResearchProposalSchema = ResearchSchema.pick({
  id: true,
  status: true,
  analysis: true,
  sourceHead: true,
  profileRevision: true,
  context: true,
  components: true,
  checks: true,
  reviewedProfileRevision: true,
  appliedProfileRevision: true,
})
  .extend({
    context: ResearchResultSchema.shape.context.optional(),
    components: ResearchResultSchema.shape.components.optional(),
  })
  .strict();
const agentSession = z.object({
  id: z.string(),
  roleId: z.string(),
  roleVersion: z.number().int().nonnegative(),
  runtimeId: z.string(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  reportedModel: z.string().optional(),
  configurationRevision: z.string().optional(),
  selection: AssignmentSelectionSchema.optional(),
  parentId: z.string().optional(),
  result: z
    .object({
      status: z.enum(['success', 'fail']),
      summary: z.string(),
      artifacts: z.array(z.string()),
      notesForNextAgent: z.string(),
    })
    .optional(),
});
const run = z
  .object({
    reconciliation: RunReconciliationSchema.optional(),
    verificationView: VerificationViewSchema.optional(),
    verificationEvidence: VerificationEvidenceSchema.optional(),
    pendingTurn: PendingRunTurnSchema.optional(),
    planningPolicy: PlanningPolicySchema.optional(),
    effectivePolicy: EffectivePolicySchema.optional(),
    stop: RunStopSchema.optional(),
    managedBudget: ManagedRunBudgetSummarySchema.optional(),
    workerTasks: z.record(z.string(), WorkerTaskSchema).optional(),
    workerReplan: WorkerReplanSchema.optional(),
    resources: ResourceSnapshotSchema.optional(),
    assignmentResources: z.record(z.string(), AssignmentResourceSchema).optional(),
    roleResources: z.record(z.string(), AssignmentResourceSchema).optional(),
    workflow: WorkflowIdentitySchema.optional(),
    operationContexts: z
      .record(z.string(), SavedOperationContextSchema)
      .refine(
        (contexts) => Object.entries(contexts).every(([id, context]) => id === context.id),
        'Operation context keys must match their captured identity.',
      )
      .optional(),
    operationResources: z
      .record(z.string(), z.record(z.string(), AssignmentResourceSchema))
      .optional(),
    delegation: z.literal('buro').optional(),
    coordinatorSession: agentSession.optional(),
    planningSession: agentSession.optional(),
    contextMaterials: z.array(ContextMaterialSchema).optional(),
    id: z.string(),
    key: z.string(),
    title: z.string(),
    summary: z.string(),
    createdAt: z.string(),
    completedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    planSavedAt: z.string().optional(),
    threadId: z.string(),
    status: z
      .enum([
        'queued',
        'running',
        'canceling',
        'completed',
        'failed',
        'interrupted',
        'needs-attention',
      ])
      .optional(),
    phase: z
      .enum([
        'preparing',
        'queued',
        'planning',
        'implementation',
        'checking',
        'review',
        'repair',
        'done',
      ])
      .optional(),
    goalId: z.string().optional(),
    workspace: z.string().optional(),
    commit: z.string().optional(),
    checkIds: z.array(z.string()).optional(),
    timePolicy: z
      .object({ kind: z.literal('inactivity'), idleTimeoutMs: z.number().positive() })
      .optional(),
    repairEnvironment: z.boolean().optional(),
    cancelRequested: z.boolean().optional(),
    review: z
      .object({
        verdict: z.enum(['approved', 'changes_requested']),
        blockingFindings: z.array(z.string()),
        summary: z.string(),
      })
      .optional(),
    roleOrigins: z.record(z.string(), z.enum(['created', 'reused'])).optional(),
    roleSnapshots: z.array(role).optional(),
    roleAssignments: z.record(z.string(), z.array(z.string())).optional(),
    continuation: z
      .object({
        mode: z.enum(['repair', 'recheck']),
        instructions: z.string(),
        requestedAt: z.string(),
      })
      .optional(),
    issue: z
      .object({
        code: z.enum([
          'BASELINE_CHECKS_FAILED',
          'EXECUTION_FAILED',
          'MANAGED_BUDGET_BLOCKED',
          'RECONCILIATION_REQUIRED',
        ]),
        budgetCode: ManagedBudgetErrorCodeSchema.optional(),
        message: z.string(),
        checks: z.array(z.string()),
      })
      .superRefine((issue, ctx) => {
        if ((issue.code === 'MANAGED_BUDGET_BLOCKED') !== (issue.budgetCode !== undefined))
          ctx.addIssue({
            code: 'custom',
            message: 'A managed budget issue requires its typed budget code.',
          });
      })
      .optional(),
    attempts: z
      .array(
        z.object({
          at: z.string(),
          status: z.string(),
          result: z.string(),
          policy: z.unknown().optional(),
          planningPolicy: PlanningPolicySchema.optional(),
          goalText: z.string(),
          contextMaterials: z.array(ContextMaterialSchema).optional(),
          repairEnvironment: z.boolean().optional(),
          timePolicy: z
            .object({ kind: z.literal('inactivity'), idleTimeoutMs: z.number().positive() })
            .optional(),
        }),
      )
      .optional(),
    baseCommit: z.string().optional(),
    baseBranch: z.string().optional(),
    parentRunId: z.string().optional(),
    outcome: GoalOutcomeSchema.optional(),
    delivery: DeliverySchema.optional(),
    deliveryHistory: z.array(DeliverySchema).optional(),
    preview: PreviewSchema.optional(),
    resultAgents: z
      .array(
        z.object({
          session: agentSession.optional(),
          threadId: z.string(),
          name: z.string(),
          agentPath: z.string(),
          startedAt: z.string(),
          completedAt: z.string(),
          messages: z.array(z.string()),
          commands: z.number(),
          status: z.string(),
        }),
      )
      .optional(),
    appliedAt: z.string().optional(),
    appliedBranch: z.string().optional(),
    executionPolicySnapshot: ExecutionPolicySchema.extend({
      turnTimeoutMs: z.number(),
      context: z.string().optional(),
      profile: ProjectProfileSchema.optional(),
    }).optional(),
    agents: z.array(
      z.object({
        session: agentSession.optional(),
        threadId: z.string(),
        name: z.string(),
        agentPath: z.string(),
        startedAt: z.string(),
        completedAt: z.string(),
        messages: z.array(z.string()),
        commands: z.number(),
        status: z.string(),
        assignment: z
          .object({
            paths: z.array(z.string()),
            envelope: WorkerEnvelopeSchema.optional(),
            knownFailure: WorkerKnownFailureSchema.optional(),
          })
          .optional(),
      }),
    ),
    events: z.array(
      z.object({
        type: z.string(),
        at: z.string(),
        threadId: z.string().optional(),
        text: z.string().optional(),
        commandId: z.string().optional(),
        durationMs: z.number().nonnegative().optional(),
      }),
    ),
    commands: z.array(
      z.object({
        id: z.string(),
        threadId: z.string(),
        command: z.string(),
        startedAt: z.string(),
        completedAt: z.string().optional(),
        exitCode: z.number().nullable().optional(),
        output: z
          .string()
          .nullish()
          .transform((v) => v ?? undefined),
      }),
    ),
    plan: z.array(z.object({ step: z.string(), owner: z.string() })),
    changedFiles: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
    baseline: checks,
    acceptance: checks,
    specsUnchanged: z.boolean(),
    scopePreserved: z.boolean(),
    scopeObservation: ScopeObservationSchema.optional(),
    independentReviewer: z.boolean(),
    goalText: z.string(),
    result: z.string(),
    sourceHash: z.string(),
  })
  .superRefine((run, ctx) => {
    if (
      run.verificationView &&
      (run.verificationView.runId !== run.id ||
        run.verificationView.sourceWorkspace !== run.workspace ||
        run.verificationView.base !== run.baseCommit)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A verification view must belong to this run, workspace and Git base.',
      });
    if (run.status === 'completed' && (run.reconciliation || run.pendingTurn))
      ctx.addIssue({
        code: 'custom',
        message: 'A completed run cannot retain an unsettled effect.',
      });
    if (run.issue?.code === 'RECONCILIATION_REQUIRED' && !run.reconciliation)
      ctx.addIssue({
        code: 'custom',
        message: 'A reconciliation issue requires its durable reference.',
      });
    if (run.planningPolicy) {
      const coordinator = run.roleResources?.coordinator?.resource || run.resources?.coordinator;
      if (!coordinator || !planningPolicyMatchesResource(run.planningPolicy, coordinator))
        ctx.addIssue({
          code: 'custom',
          message: 'Planning requires its saved configured backend and capabilities.',
        });
    }
  });
/** Public queued presentation only; no resource, role, session or writable grant fields. */
export const RunAdmissionViewSchema = z.strictObject({
  managedBudget: ManagedRunBudgetSummarySchema.optional(),
  effectivePolicy: EffectivePolicySchema.optional(),
  stop: RunStopSchema.optional(),
  issue: run.shape.issue.unwrap().strict().optional(),
});
export const DomainEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    projectId: z.string(),
    seq: z.number().int().positive(),
    at: z.string(),
    change: z.discriminatedUnion('type', [
      z.object({ type: z.literal('goal.created'), goal }),
      z.object({ type: z.literal('goal.updated'), goal }),
      z.object({ type: z.literal('goal.deleted'), id: z.string() }),
      z.object({ type: z.literal('role.saved'), role }),
      z.object({
        type: z.literal('context.materials.added'),
        materials: z.array(ContextMaterialSchema),
      }),
      z.object({ type: z.literal('context.material.removed'), id: z.string() }),
      z.object({
        type: z.literal('project.research.changed'),
        research: ResearchSchema,
        roles: z.array(role).optional(),
      }),
      z.object({ type: z.literal('project.verified'), verification }),
      z.strictObject({
        type: z.literal('project.configured'),
        researchAcknowledgement: ResearchAcknowledgementSchema.optional(),
        profile: ProjectProfileSchema,
        executionPolicy: ExecutionPolicySchema,
      }),
      z.strictObject({
        type: z.literal('run.admitted'),
        view: RunAdmissionViewSchema.optional(),
        current: RunCurrentSchema,
        admission: RunAdmissionSchema,
        goal,
        roles: z.array(role).optional(),
      }),
      z.strictObject({ type: z.literal('run.cancel-requested'), current: RunCurrentSchema }),
      z.object({ type: z.literal('run.changed'), run, goal, roles: z.array(role).optional() }),
    ]),
  })
  .superRefine((event, ctx) => {
    if (event.change.type === 'run.admitted') {
      const { current, admission, goal: linkedGoal } = event.change;
      if (
        current.status !== 'queued' ||
        current.phase !== 'queued' ||
        current.revision !== 1 ||
        current.cancelRequested ||
        current.completedAt !== undefined ||
        linkedGoal.status !== 'running'
      )
        ctx.addIssue({
          code: 'custom',
          path: ['change', 'current'],
          message: 'A run admission describes only newly queued work.',
        });
      if (
        current.id !== admission.runId ||
        current.admissionId !== admission.id ||
        current.attemptId !== admission.attemptId ||
        current.goalId !== admission.goal.id ||
        current.goalId !== linkedGoal.id ||
        linkedGoal.runId !== current.id ||
        linkedGoal.projectId !== event.projectId ||
        admission.goal.projectId !== event.projectId
      )
        ctx.addIssue({
          code: 'custom',
          path: ['change'],
          message: 'Run admission identities must match the current run and linked project goal.',
        });
    }
    if (
      event.change.type === 'run.cancel-requested' &&
      (!event.change.current.cancelRequested || event.change.current.status !== 'canceling')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['change', 'current'],
        message: 'Cancellation must describe an actual stop request.',
      });
    if (
      event.change.type === 'run.changed' &&
      event.change.run.verificationView &&
      event.change.run.verificationView.projectId !== event.projectId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A verification view cannot cross the event project.',
      });
  });
export const SnapshotSchema = z
  .object({
    contextMaterials: z.array(ContextMaterialSchema).optional(),
    version: z.literal(1),
    project: ProjectSchema,
    revision: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    roles: z.array(role),
    goals: z.array(goal),
    runs: z.array(run),
    capabilities: z.array(z.string()),
    executionPolicy: ExecutionPolicySchema.optional(),
    effectivePolicy: EffectivePolicySchema.optional(),
    profile: ProjectProfileSchema.optional(),
    verification: verification.optional(),
    research: ResearchSchema.optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.runs.some(
        (run) => run.verificationView && run.verificationView.projectId !== snapshot.project.id,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A verification view cannot cross the snapshot project.',
      });
  });
export function parseSnapshot(input: unknown): Snapshot {
  return SnapshotSchema.parse(input) as unknown as Snapshot;
}
export const ServiceInfoSchema = z
  .strictObject({
    version: z.literal(1),
    projects: z.array(ProjectSchema),
    capabilities: z.array(z.string()),
  })
  .superRefine((info, ctx) => {
    if (new Set(info.projects.map((project) => project.id)).size !== info.projects.length)
      ctx.addIssue({ code: 'custom', message: 'Service project IDs must be unique.' });
  });
export function parseServiceInfo(input: unknown): ServiceInfo {
  return ServiceInfoSchema.parse(input);
}
export function parseDomainEvent(input: unknown): DomainEvent {
  return DomainEventSchema.parse(input) as DomainEvent;
}
