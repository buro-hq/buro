import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkScopeSchema } from '../../protocol/work-scope.ts';
import { DomainError } from '../../core/ports.ts';
import { assertManagedSessionProvenance } from '../../core/managed-session-authority.ts';
import {
  rejectedToolBatchMessages,
  undispatchedToolResult,
} from '../../core/managed-tool-feedback.ts';
import type { ManagedSession, ManagedSessionStore } from '../../core/model-ports.ts';
import {
  parseSegmentClosing,
  segmentActionReceipts,
  segmentMessages,
  segmentFinalFormatTask,
  validateSegmentEvidence,
  validateSegmentLimits,
} from '../../core/work-segments.ts';
import {
  validateWorkerStepCheckPlan,
  validateWorkerStepCheckResult,
  workerStepFeedback,
} from '../../core/worker-step-checks.ts';

const call = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
const result = z.object({
  content: z.string(),
  isError: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
});
const scope = z.object({
  projectId: z.string(),
  runId: z.string().optional(),
  ownerRunId: z.string().optional(),
  sessionId: z.string(),
  workspace: z.string(),
  verificationViewId: z.string().min(1).optional(),
  verificationTree: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  readOnly: z.boolean(),
  writeScope: WorkScopeSchema,
  materials: z.array(z.string()),
  commands: z.array(z.object({ id: z.string(), command: z.string(), timeoutMs: z.number() })),
  baseCommit: z.string().optional(),
});
const message = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(call).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  continuation: z.unknown().optional(),
});
const completion = z.strictObject({
  message: message.extend({ role: z.literal('assistant') }),
  model: z.string(),
  usage: z
    .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
    .optional(),
  finish: z.enum(['stop', 'tools', 'length', 'failed']),
});
const anchor = z.strictObject({
  turnId: z.string().min(1),
  instructions: z.string(),
  task: z.string(),
  scopeRevision: z.number().int().positive(),
});
const evidence = z.strictObject({
  version: z.literal(1),
  baseCommit: z.string(),
  headCommit: z.string(),
  workspaceFingerprint: z.string(),
  files: z.array(z.strictObject({ path: z.string(), fingerprint: z.string() })).max(256),
});
const workerStepCheckPlan = z.strictObject({
  version: z.literal(1),
  checkIds: z.array(z.string().min(1).max(100)).min(1).max(8),
  configurationRevision: z.string(),
});
const workerStepCheckResult = z.strictObject({
  version: z.literal(1),
  outcome: z.enum(['completed', 'unavailable']),
  workspaceFingerprint: z.string(),
  checkIds: z.array(z.string().min(1).max(100)).min(1).max(8),
  passed: z.number().int().nonnegative(),
  total: z.number().int().positive().max(8),
  results: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        status: z.enum(['passed', 'failed', 'unavailable']),
        exitCode: z.number().int().nullable().optional(),
        diagnostic: z.string().max(512),
      }),
    )
    .min(1)
    .max(8),
});
const workerStepChecks = z.strictObject({
  version: z.literal(1),
  revision: z.literal('worker-step-checks-v1'),
  maxFeedbackSteps: z.number().int().positive().optional(),
  feedbackSteps: z.number().int().nonnegative(),
  entries: z.array(
    z.strictObject({
      id: z.string().min(1),
      turnId: z.string().min(1),
      scopeRevision: z.number().int().positive(),
      requestedAtRequest: z.number().int().positive(),
      plan: workerStepCheckPlan,
      before: evidence,
      status: z.enum(['pending', 'completed', 'unknown']),
      result: workerStepCheckResult.optional(),
    }),
  ),
});
const workSegments = z.strictObject({
  version: z.literal(1),
  limits: z.strictObject({
    revision: z.string(),
    maxToolRounds: z.number().int().optional(),
    maxSegments: z.number().int().optional(),
    contextThresholdPercent: z.number().int().optional(),
  }),
  baseline: evidence,
  anchor,
  active: z.strictObject({
    index: z.number().int().positive(),
    startedAtRequest: z.number().int().nonnegative(),
    toolRounds: z.number().int().nonnegative(),
  }),
  archives: z.array(
    z.strictObject({
      index: z.number().int().positive(),
      anchor,
      startedAtRequest: z.number().int().nonnegative(),
      endedAtRequest: z.number().int().positive(),
      messages: z.array(message).min(1),
      intermediateNotes: z.array(z.number().int().nonnegative()).optional(),
      handoff: z.strictObject({
        version: z.literal(1),
        nextTask: z.string().min(1).max(1000),
        evidence,
        completedActions: z.number().int().nonnegative(),
        kind: z.enum(['check-feedback', 'service-turn', 'final-format']).optional(),
        checkFeedback: z
          .strictObject({
            receiptId: z.string().min(1),
            result: workerStepCheckResult,
          })
          .optional(),
        availableTools: z.array(z.string().min(1).max(100)).max(32).optional(),
        receipts: z
          .array(
            z.strictObject({
              actionId: z.string().min(1),
              toolName: z.string().min(1),
              target: z.string().max(1000).optional(),
              isError: z.boolean(),
              output: z.string().max(512),
            }),
          )
          .max(6)
          .optional(),
      }),
    }),
  ),
});
const schema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    runtimeId: z.string(),
    limits: z.object({
      contextTokens: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      maxRequestsPerTurn: z.number().int().positive().optional(),
      maxToolCallsPerTurn: z.number().int().positive().optional(),
      maxSessionRequests: z.number().int().positive().optional(),
      maxFeedbackSteps: z.number().int().positive().optional(),
    }),
    providerId: z.string(),
    providerRevision: z.string(),
    toolRevision: z.string().min(1),
    requestedModel: z.string(),
    reportedModel: z.string().optional(),
    purpose: z
      .enum(['coordination', 'implementation', 'review', 'research', 'environment', 'delivery'])
      .optional(),
    scope,
    assignment: z
      .object({
        roleId: z.string(),
        scope: WorkScopeSchema,
      })
      .optional(),
    scopeRevisions: z
      .array(z.object({ revision: z.number().int().positive(), scope, instructions: z.string() }))
      .min(1),
    turnAuthorities: z
      .array(
        z.strictObject({
          turnId: z.string().min(1).max(256),
          toolPolicy: z.enum(['none', 'normal']),
          startedAtRequest: z.number().int().nonnegative(),
          scopeRevision: z.number().int().positive(),
        }),
      )
      .optional(),
    messages: z.array(message),
    intermediateNotes: z.array(z.number().int().nonnegative()).optional(),
    workSegments: workSegments.optional(),
    workerStepChecks: workerStepChecks.optional(),
    generation: z
      .strictObject({
        requestId: z.string().min(1).max(256),
        outcome: z.enum(['pending', 'completed', 'unknown']),
        response: completion.optional(),
        admittedActionIds: z.array(z.string().min(1)).min(1).optional(),
        rejectionCode: z.string().optional(),
      })
      .optional(),
    rejectedToolBatches: z
      .array(
        z.strictObject({
          requestId: z.string().min(1).max(256),
          turnId: z.string().min(1).max(256),
          scopeRevision: z.number().int().positive(),
          requestedAtRequest: z.number().int().positive(),
          availableTools: z.array(z.string().min(1)),
          response: completion,
        }),
      )
      .optional(),
    status: z.enum(['ready', 'running', 'interrupted', 'failed']),
    cancelRequested: z.boolean().optional(),
    requests: z.number().int().nonnegative(),
    usage: z.object({
      requestsWithUsage: z.number().int().nonnegative(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    }),
    actions: z.array(
      z.object({
        id: z.string(),
        turnId: z.string(),
        call,
        status: z.enum(['pending', 'completed', 'unknown']),
        result: result.optional(),
      }),
    ),
  })
  .superRefine((session, ctx) => {
    if (session.purpose === 'review' && (!session.scope.readOnly || session.assignment))
      ctx.addIssue({
        code: 'custom',
        path: ['purpose'],
        message: 'A reviewer must be a read-only service session without a worker assignment.',
      });
    const notes = session.intermediateNotes || [];
    if (
      notes.some(
        (index, position) =>
          (position > 0 && index <= notes[position - 1]) ||
          session.messages[index]?.role !== 'assistant' ||
          !!session.messages[index]?.toolCalls?.length ||
          session.messages[index + 1]?.role !== 'user',
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['intermediateNotes'],
        message:
          'Intermediate notes must be unique ordered no-tool assistant messages followed by a user message.',
      });
  });

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function invalidSegment(message: string): never {
  throw new DomainError('INVALID_CHECKPOINT', message);
}
function validateNotes(messages: ManagedSession['messages'], notes: number[] = []) {
  if (
    notes.some(
      (index, position) =>
        (position > 0 && index <= notes[position - 1]) ||
        messages[index]?.role !== 'assistant' ||
        !!messages[index]?.toolCalls?.length ||
        messages[index + 1]?.role !== 'user',
    )
  )
    invalidSegment('An archived intermediate note has invalid provenance.');
}
function validateWorkerCheckCheckpoint(session: ManagedSession) {
  const journal = session.workerStepChecks;
  const feedback =
    session.workSegments?.archives.filter((archive) => archive.handoff.kind === 'check-feedback') ||
    [];
  if (!journal) {
    if (feedback.length)
      invalidSegment('Check feedback requires its private service-check journal.');
    return;
  }
  if (
    !session.workSegments ||
    journal.maxFeedbackSteps !== session.limits.maxFeedbackSteps ||
    (journal.maxFeedbackSteps !== undefined && journal.feedbackSteps > journal.maxFeedbackSteps) ||
    journal.feedbackSteps !== feedback.length
  )
    invalidSegment('The worker check feedback counter must match its archived steps.');
  const ids = new Set<string>();
  let requested = 0;
  for (const [index, entry] of journal.entries.entries()) {
    validateWorkerStepCheckPlan(entry.plan);
    validateSegmentEvidence(entry.before);
    if (
      ids.has(entry.id) ||
      entry.requestedAtRequest < requested ||
      entry.requestedAtRequest > session.requests ||
      !session.scopeRevisions.some((revision) => revision.revision === entry.scopeRevision) ||
      (entry.status === 'completed') !== !!entry.result ||
      (entry.status !== 'completed' && index !== journal.entries.length - 1)
    )
      invalidSegment('The worker check journal has invalid identity, counters or outcome.');
    if (entry.result)
      validateWorkerStepCheckResult(entry.plan, entry.before.workspaceFingerprint, entry.result);
    ids.add(entry.id);
    requested = entry.requestedAtRequest;
  }
}
function validateSegmentCheckpoint(session: ManagedSession) {
  assertManagedSessionProvenance(session);
  if (
    session.scope.verificationViewId !== undefined ||
    session.scope.verificationTree !== undefined
  ) {
    if (
      !session.scope.verificationViewId ||
      !session.scope.verificationTree ||
      session.purpose !== 'review' ||
      !session.scope.readOnly ||
      session.assignment
    )
      invalidSegment(
        'A verification scope requires a read-only service reviewer and frozen source identity.',
      );
  }
  validateTurnAuthorities(session);
  validateWorkerCheckCheckpoint(session);
  validateRejectedToolBatches(session);
  const generation = session.generation;
  if (generation?.admittedActionIds) {
    const calls = generation.response?.message.toolCalls || [];
    if (
      generation.outcome !== 'completed' ||
      generation.response?.finish !== 'tools' ||
      !calls.length ||
      generation.admittedActionIds.length !== calls.length ||
      new Set(generation.admittedActionIds).size !== calls.length ||
      calls.some(
        (call, index) =>
          !session.actions.some(
            (action) =>
              action.id === generation.admittedActionIds![index] && same(action.call, call),
          ),
      ) ||
      session.rejectedToolBatches?.some((batch) => batch.requestId === generation.requestId)
    )
      invalidSegment(
        'A tool admission marker must identify exactly its completed generation batch.',
      );
  }
  const state = session.workSegments;
  if (!state) return;
  validateSegmentLimits(state.limits);
  validateSegmentEvidence(state.baseline);
  if (
    state.active.index !== state.archives.length + 1 ||
    (state.limits.maxSegments !== undefined && state.active.index > state.limits.maxSegments) ||
    state.active.startedAtRequest > session.requests ||
    state.active.toolRounds > session.requests - state.active.startedAtRequest
  )
    invalidSegment('The active work segment has invalid lifetime counters.');
  const revisions = session.scopeRevisions;
  const validateAnchor = (value: typeof state.anchor) => {
    const revision = revisions.find((item) => item.revision === value.scopeRevision);
    if (!revision || revision.instructions !== value.instructions)
      invalidSegment('A work segment lost its frozen instruction revision.');
  };
  validateAnchor(state.anchor);
  const actionIds = new Set<string>(),
    callIds = new Set<string>();
  for (const action of session.actions) {
    if (actionIds.has(action.id) || callIds.has(action.call.id))
      invalidSegment('A work segment contains duplicate action identities.');
    actionIds.add(action.id);
    callIds.add(action.call.id);
    if (action.status === 'completed' && !action.result)
      invalidSegment('A completed action lost its result.');
  }
  let ended = 0,
    completed = 0;
  const feedbackReceipts = new Set<string>();
  for (const [position, archive] of state.archives.entries()) {
    validateAnchor(archive.anchor);
    validateSegmentEvidence(archive.handoff.evidence);
    validateNotes(archive.messages, archive.intermediateNotes);
    if (
      archive.index !== position + 1 ||
      archive.startedAtRequest < ended ||
      archive.endedAtRequest <= archive.startedAtRequest ||
      archive.endedAtRequest > session.requests ||
      archive.handoff.completedActions < completed ||
      archive.handoff.completedActions > session.actions.length ||
      session.actions
        .slice(0, archive.handoff.completedActions)
        .some((action) => action.status !== 'completed') ||
      archive.handoff.evidence.baseCommit !== state.baseline.baseCommit ||
      archive.handoff.evidence.headCommit !== state.baseline.headCommit
    )
      invalidSegment('An archived work segment has invalid evidence or lifetime counters.');
    if (
      archive.handoff.receipts &&
      !same(
        archive.handoff.receipts,
        segmentActionReceipts(session.actions.slice(0, archive.handoff.completedActions)),
      )
    )
      invalidSegment('A handoff receipt must match its completed tool action.');
    if (
      archive.handoff.availableTools &&
      new Set(archive.handoff.availableTools).size !== archive.handoff.availableTools.length
    )
      invalidSegment('The handoff tool names must be unique.');
    const receipts = [
      ...session.actions.slice(0, archive.handoff.completedActions),
      ...(session.rejectedToolBatches || [])
        .filter(
          // A context window may contain several settled service turns. Match receipts
          // by the actual archived call chain, not the most recently refreshed anchor.
          (batch) => batch.requestedAtRequest <= archive.endedAtRequest,
        )
        .flatMap((batch) =>
          (batch.response.message.toolCalls || []).map((call, index) => ({
            call,
            status: 'completed' as const,
            result: { content: rejectedToolBatchMessages(batch)[index + 1].content, isError: true },
          })),
        ),
    ];
    const pending = new Map<string, (typeof receipts)[number]>();
    const seen = new Set<string>();
    for (const item of archive.messages) {
      if (item.role === 'tool') {
        const action = item.toolCallId ? pending.get(item.toolCallId) : undefined;
        if (
          !action ||
          action.result?.content !== item.content ||
          item.toolName !== action.call.name
        )
          invalidSegment('An archived tool result is missing its completed action receipt.');
        pending.delete(item.toolCallId!);
        continue;
      }
      if (pending.size) invalidSegment('An archive split a required tool-result chain.');
      if (item.toolCalls?.length) {
        if (item.role !== 'assistant') invalidSegment('Only an assistant may request tools.');
        for (const requested of item.toolCalls) {
          const action = receipts.find((entry) => entry.call.id === requested.id);
          if (
            !action ||
            action.status !== 'completed' ||
            !same(action.call, requested) ||
            seen.has(requested.id)
          )
            invalidSegment('An archived tool call is missing its completed action receipt.');
          seen.add(requested.id);
          pending.set(requested.id, action);
        }
      }
    }
    const last =
      archive.handoff.kind === 'service-turn'
        ? [...archive.messages].reverse().find((message) => message.role !== 'system')
        : archive.messages.at(-1);
    if (pending.size || last?.role !== 'assistant' || last.toolCalls?.length)
      invalidSegment('A work segment was archived before its model round settled.');
    if (archive.handoff.kind === 'check-feedback') {
      const feedback = archive.handoff.checkFeedback;
      const entry = session.workerStepChecks?.entries.find(
        (item) => item.id === feedback?.receiptId,
      );
      if (
        !feedback ||
        !entry ||
        entry.status !== 'completed' ||
        !entry.result ||
        entry.turnId !== archive.anchor.turnId ||
        entry.scopeRevision !== archive.anchor.scopeRevision ||
        entry.requestedAtRequest !== archive.endedAtRequest ||
        !same(entry.before, archive.handoff.evidence) ||
        !same(entry.result, feedback.result) ||
        feedbackReceipts.has(entry.id) ||
        archive.handoff.nextTask !== workerStepFeedback(entry)
      )
        invalidSegment(
          'A focused repair must reference one actual failed service check on the archived workspace.',
        );
      feedbackReceipts.add(entry.id);
    } else if (archive.handoff.kind === 'service-turn') {
      if (
        session.purpose !== 'coordination' ||
        session.assignment ||
        session.scope.readOnly ||
        archive.handoff.checkFeedback ||
        archive.handoff.nextTask !== 'Continue the goal using the current service observations.'
      )
        invalidSegment('Only a settled coordinator service turn may issue this context boundary.');
    } else if (archive.handoff.kind === 'final-format') {
      const closing = parseSegmentClosing(last.content);
      if (
        archive.handoff.checkFeedback ||
        closing.status !== 'complete' ||
        archive.handoff.nextTask !== segmentFinalFormatTask
      )
        invalidSegment(
          'A final-format boundary requires a completed closing reply and the original task.',
        );
    } else {
      if (archive.handoff.checkFeedback)
        invalidSegment('Service check evidence requires an explicit check-feedback boundary.');
      const closing = parseSegmentClosing(last.content);
      if (closing.status !== 'continue' || closing.nextTask !== archive.handoff.nextTask)
        invalidSegment('The archived closing reply does not match its next-task proposal.');
    }
    ended = archive.endedAtRequest;
    completed = archive.handoff.completedActions;
  }
  if (state.active.startedAtRequest < ended)
    invalidSegment('The active segment rewound the archived request count.');
}

function validateWorkerCheckTransition(previous: ManagedSession, next: ManagedSession) {
  const before = previous.workerStepChecks,
    after = next.workerStepChecks;
  if (!before && !after) return;
  if (
    !after ||
    (before &&
      (before.revision !== after.revision ||
        before.maxFeedbackSteps !== after.maxFeedbackSteps ||
        after.feedbackSteps < before.feedbackSteps ||
        after.entries.length < before.entries.length))
  )
    invalidSegment('The private service-check journal and its feedback allowance cannot be reset.');
  const oldEntries = before?.entries || [];
  if (after.entries.length > oldEntries.length + 1)
    invalidSegment('Service checks must persist each intent before dispatch.');
  for (const [index, entry] of oldEntries.entries()) {
    const candidate = after.entries[index];
    const { status: oldStatus, result: oldResult, ...oldContract } = entry;
    const { status: newStatus, result: newResult, ...newContract } = candidate;
    if (
      !same(oldContract, newContract) ||
      (oldStatus !== 'pending' && !same(entry, candidate)) ||
      (oldStatus === 'pending' && newStatus === 'pending' && !same(oldResult, newResult))
    )
      invalidSegment(
        'An observed or unknown service-check receipt cannot be rewritten or replayed.',
      );
  }
  if (after.entries.length > oldEntries.length) {
    const entry = after.entries.at(-1)!,
      anchor = next.workSegments?.anchor;
    if (
      oldEntries.some((item) => item.status !== 'completed') ||
      entry.status !== 'pending' ||
      entry.result ||
      next.cancelRequested ||
      next.generation?.outcome !== 'completed' ||
      next.actions.some((action) => action.status !== 'completed') ||
      entry.requestedAtRequest !== next.requests ||
      entry.turnId !== anchor?.turnId ||
      entry.scopeRevision !== anchor?.scopeRevision
    )
      invalidSegment(
        'A service check requires a fresh durable intent and a settled worker generation.',
      );
  }
}

/** Segmentation may rotate context, but never rewrite completed private history or lifetime charges. */
function validateTurnAuthorities(session: ManagedSession) {
  const ids = new Set<string>();
  let started = 0;
  for (const authority of session.turnAuthorities || []) {
    if (
      ids.has(authority.turnId) ||
      authority.startedAtRequest < started ||
      authority.startedAtRequest > session.requests ||
      !session.scopeRevisions.some((revision) => revision.revision === authority.scopeRevision) ||
      (authority.toolPolicy === 'none' &&
        session.actions.some((action) => action.turnId === authority.turnId))
    )
      invalidSegment('A turn authority has invalid provenance or unauthorized tool actions.');
    ids.add(authority.turnId);
    started = authority.startedAtRequest;
  }
}

function validateTurnAuthorityTransition(previous: ManagedSession, next: ManagedSession) {
  const before = previous.turnAuthorities || [];
  const after = next.turnAuthorities || [];
  if (
    (previous.turnAuthorities && !next.turnAuthorities) ||
    after.length < before.length ||
    after.length > before.length + 1 ||
    !same(before, after.slice(0, before.length))
  )
    invalidSegment('The private turn authority journal is append-only.');
  if (after.length > before.length) {
    const authority = after.at(-1)!;
    if (
      authority.startedAtRequest !== previous.requests ||
      next.requests !== previous.requests ||
      authority.scopeRevision !== next.scopeRevisions.at(-1)!.revision ||
      next.status !== 'running' ||
      next.actions.length !== previous.actions.length
    )
      invalidSegment('A turn authority must be saved before its first generation or action.');
  }
  for (const action of next.actions.slice(previous.actions.length)) {
    if (
      !after.some(
        (authority) => authority.turnId === action.turnId && authority.toolPolicy === 'normal',
      )
    )
      invalidSegment('A new tool action requires a persisted normal turn authority.');
  }
}

function validateRejectedToolBatches(session: ManagedSession) {
  const ids = new Set(session.actions.map((action) => action.call.id));
  const requests = new Set<string>();
  let requestedAt = 0;
  const histories = [
    session.messages,
    ...(session.workSegments?.archives.map((archive) => archive.messages) || []),
  ];
  for (const batch of session.rejectedToolBatches || []) {
    const authority = session.turnAuthorities?.find((turn) => turn.turnId === batch.turnId);
    const calls = batch.response.message.toolCalls || [];
    const chain = rejectedToolBatchMessages(batch);
    if (
      !authority ||
      authority.toolPolicy !== 'normal' ||
      authority.scopeRevision !== batch.scopeRevision ||
      requests.has(batch.requestId) ||
      batch.requestedAtRequest <= requestedAt ||
      batch.requestedAtRequest > session.requests ||
      batch.response.finish !== 'tools' ||
      !calls.length ||
      new Set(batch.availableTools).size !== batch.availableTools.length ||
      !calls.some((call) => !batch.availableTools.includes(call.name)) ||
      calls.some(
        (call) =>
          !call.id ||
          !call.name ||
          !call.arguments ||
          typeof call.arguments !== 'object' ||
          Array.isArray(call.arguments),
      ) ||
      !histories.some((messages) =>
        messages.some((_, index) => same(messages.slice(index, index + chain.length), chain)),
      )
    )
      invalidSegment(
        'A rejected tool proposal must retain its completed response and correlated feedback.',
      );
    for (const call of calls) {
      if (ids.has(call.id)) invalidSegment('A rejected tool call identity cannot be reused.');
      ids.add(call.id);
    }
    requests.add(batch.requestId);
    requestedAt = batch.requestedAtRequest;
  }
}

function validateRejectedToolTransition(previous: ManagedSession, next: ManagedSession) {
  const before = previous.rejectedToolBatches || [],
    after = next.rejectedToolBatches || [];
  if (
    after.length < before.length ||
    after.length > before.length + 1 ||
    !same(before, after.slice(0, before.length))
  )
    invalidSegment('Rejected tool receipts are append-only.');
  if (after.length === before.length) return;
  const batch = after.at(-1)!,
    generation = previous.generation;
  const authority = previous.turnAuthorities?.at(-1);
  if (
    previous.cancelRequested ||
    next.cancelRequested ||
    previous.status !== 'running' ||
    next.status !== 'running' ||
    !generation ||
    generation.outcome !== 'completed' ||
    generation.requestId !== batch.requestId ||
    !same(generation, next.generation) ||
    generation.admittedActionIds ||
    !same(generation.response, batch.response) ||
    authority?.turnId !== batch.turnId ||
    authority.toolPolicy !== 'normal' ||
    batch.scopeRevision !== previous.scopeRevisions.at(-1)!.revision ||
    batch.requestedAtRequest !== previous.requests ||
    next.requests !== previous.requests ||
    !same(previous.scopeRevisions, next.scopeRevisions) ||
    !same(previous.actions, next.actions) ||
    next.actions.some((action) => action.status !== 'completed') ||
    next.workerStepChecks?.entries.some((entry) => entry.status !== 'completed') ||
    !same(next.messages, [...previous.messages, ...rejectedToolBatchMessages(batch)]) ||
    next.usage.requestsWithUsage - previous.usage.requestsWithUsage !==
      (batch.response.usage ? 1 : 0) ||
    next.usage.inputTokens - previous.usage.inputTokens !==
      (batch.response.usage?.inputTokens || 0) ||
    next.usage.outputTokens - previous.usage.outputTokens !==
      (batch.response.usage?.outputTokens || 0)
  )
    invalidSegment(
      'Tool feedback requires one completed generation and no dispatched or unsettled batch.',
    );
}

function validateTransition(previous: ManagedSession | undefined, next: ManagedSession) {
  if (!previous) return;
  if (previous.toolRevision !== next.toolRevision)
    invalidSegment('A saved session cannot change its tool configuration.');
  validateWorkerCheckTransition(previous, next);
  validateRejectedToolTransition(previous, next);
  if (
    previous.generation &&
    next.generation &&
    previous.generation.requestId === next.generation.requestId
  ) {
    const before = previous.generation!,
      after = next.generation!;
    if (before.admittedActionIds && !same(before.admittedActionIds, after.admittedActionIds))
      invalidSegment('A generation cannot rewrite its admitted batch.');
    if (!before.admittedActionIds && after.admittedActionIds) {
      const added = next.actions.slice(previous.actions.length),
        calls = before.response?.message.toolCalls || [];
      const authority = previous.turnAuthorities?.at(-1);
      const undispatched =
        ['failed', 'interrupted'].includes(next.status) &&
        added.every(
          (action) => action.status === 'completed' && same(action.result, undispatchedToolResult),
        );
      const appended = [
        before.response?.message,
        ...(undispatched
          ? added.map((action) => ({
              role: 'tool',
              content: action.result!.content,
              toolCallId: action.call.id,
              toolName: action.call.name,
            }))
          : []),
      ];
      if (
        (!undispatched && (previous.cancelRequested || next.cancelRequested)) ||
        before.outcome !== 'completed' ||
        !same(before.response, after.response) ||
        !calls.length ||
        added.length !== calls.length ||
        !same(
          after.admittedActionIds,
          added.map((action) => action.id),
        ) ||
        added.some(
          (action, index) =>
            (!undispatched && (action.status !== 'pending' || action.result)) ||
            action.turnId !== authority?.turnId ||
            !same(action.call, calls[index]),
        ) ||
        !same(next.messages, [...previous.messages, ...appended])
      )
        invalidSegment(
          'An admission marker requires the exact new intent batch for its completed generation.',
        );
    }
  }
  if (previous.generation) {
    const before = previous.generation,
      after = next.generation;
    if (
      !after ||
      (before.outcome === 'unknown' && !same(before, after)) ||
      (before.requestId === after.requestId &&
        before.response &&
        !same(before.response, after.response)) ||
      (before.requestId === after.requestId &&
        before.rejectionCode &&
        before.rejectionCode !== after.rejectionCode) ||
      (before.outcome === 'pending' && before.requestId !== after.requestId) ||
      (before.requestId === after.requestId &&
        before.outcome === 'completed' &&
        after.outcome !== 'completed') ||
      (before.requestId !== after.requestId &&
        (before.outcome !== 'completed' ||
          after.outcome !== 'pending' ||
          next.requests <= previous.requests))
    )
      invalidSegment('An unresolved generation cannot be erased or automatically replayed.');
  }
  // Every session retains turn authority and cumulative accounting across context windows.
  if (previous.turnAuthorities || next.turnAuthorities)
    validateTurnAuthorityTransition(previous, next);
  if (previous.workSegments && !next.workSegments)
    invalidSegment('The work segment archive cannot be removed.');
  if (
    previous.id !== next.id ||
    previous.runtimeId !== next.runtimeId ||
    previous.providerId !== next.providerId ||
    previous.providerRevision !== next.providerRevision ||
    previous.requestedModel !== next.requestedModel ||
    previous.purpose !== next.purpose ||
    !same(previous.limits, next.limits) ||
    !same(previous.assignment, next.assignment) ||
    next.requests < previous.requests ||
    (Object.keys(previous.usage) as (keyof ManagedSession['usage'])[]).some(
      (key) => next.usage[key] < previous.usage[key],
    ) ||
    next.actions.length < previous.actions.length
  )
    invalidSegment('A segmented session cannot reset identity, limits or cumulative accounting.');
  if (
    !same(previous.scopeRevisions, next.scopeRevisions.slice(0, previous.scopeRevisions.length)) ||
    next.scopeRevisions.length < previous.scopeRevisions.length ||
    next.scopeRevisions.length > previous.scopeRevisions.length + 1
  )
    invalidSegment('A segmented session cannot rewrite its instruction or scope history.');
  if (!same(previous.scope, next.scope)) {
    const revision = next.scopeRevisions.at(-1)!;
    if (
      next.scopeRevisions.length !== previous.scopeRevisions.length + 1 ||
      revision.revision !== previous.scopeRevisions.at(-1)!.revision + 1 ||
      !same(revision.scope, next.scope) ||
      previous.scope.projectId !== next.scope.projectId ||
      previous.scope.runId !== next.scope.runId ||
      previous.scope.ownerRunId !== next.scope.ownerRunId ||
      previous.scope.sessionId !== next.scope.sessionId ||
      previous.scope.workspace !== next.scope.workspace ||
      previous.scope.verificationViewId !== next.scope.verificationViewId ||
      previous.scope.verificationTree !== next.scope.verificationTree ||
      previous.scope.baseCommit !== next.scope.baseCommit ||
      previous.scope.readOnly !== next.scope.readOnly
    )
      invalidSegment('A scope change requires an explicit consistent instruction revision.');
  }
  for (const [index, action] of previous.actions.entries()) {
    const candidate = next.actions[index];
    if (
      action.id !== candidate.id ||
      action.turnId !== candidate.turnId ||
      !same(action.call, candidate.call) ||
      (action.status !== 'pending' && !same(action, candidate)) ||
      (action.status === 'pending' && candidate.status === 'pending' && !same(action, candidate))
    )
      invalidSegment('A segmented session cannot rewrite an action receipt.');
  }
  const before = previous.workSegments,
    after = next.workSegments;
  if (!before || !after) return;
  if (
    !same(before.limits, after.limits) ||
    !same(before.baseline, after.baseline) ||
    after.archives.length < before.archives.length ||
    after.archives.length > before.archives.length + 1 ||
    !same(before.archives, after.archives.slice(0, before.archives.length))
  )
    invalidSegment('The work segment archive and its frozen policy are append-only.');
  if (after.archives.length === before.archives.length + 1) {
    const archive = after.archives.at(-1)!;
    const serviceTurn = archive.handoff.kind === 'service-turn';
    const authority = next.turnAuthorities?.at(-1);
    const previousReply = [...previous.messages]
      .reverse()
      .find((message) => message.role !== 'system');
    if (
      previous.cancelRequested ||
      next.cancelRequested ||
      next.generation?.outcome !== 'completed' ||
      next.actions.some((action) => action.status !== 'completed') ||
      !same(previous.scope, next.scope) ||
      (!serviceTurn && !same(before.anchor, after.anchor)) ||
      !same(archive.anchor, before.anchor) ||
      archive.index !== before.active.index ||
      archive.startedAtRequest !== before.active.startedAtRequest ||
      archive.endedAtRequest !== next.requests ||
      archive.handoff.completedActions !== next.actions.length ||
      !same(previous.messages, archive.messages.slice(0, previous.messages.length)) ||
      after.active.index !== before.active.index + 1 ||
      after.active.startedAtRequest !== next.requests ||
      after.active.toolRounds !== 0 ||
      !same(next.messages, segmentMessages(after.anchor, next.scope, archive.handoff)) ||
      next.intermediateNotes?.length
    )
      invalidSegment(
        'A context rollover must atomically preserve a settled step and its frozen assignment.',
      );
    if (
      serviceTurn &&
      (previous.purpose !== 'coordination' ||
        previous.assignment ||
        previous.scope.readOnly ||
        previous.status !== 'ready' ||
        next.status !== 'running' ||
        previous.generation?.outcome !== 'completed' ||
        previous.generation.response?.finish !== 'stop' ||
        !same(previous.generation, next.generation) ||
        previous.actions.some((action) => action.status !== 'completed') ||
        previousReply?.role !== 'assistant' ||
        previousReply.toolCalls?.length ||
        !same(previous.messages, archive.messages) ||
        previous.requests !== next.requests ||
        next.turnAuthorities?.length !== (previous.turnAuthorities?.length || 0) + 1 ||
        !authority ||
        authority.turnId !== after.anchor.turnId ||
        authority.turnId === before.anchor.turnId ||
        authority.toolPolicy !== 'normal' ||
        authority.scopeRevision !== after.anchor.scopeRevision ||
        after.anchor.scopeRevision !== next.scopeRevisions.at(-1)!.revision ||
        after.anchor.instructions !== next.scopeRevisions.at(-1)!.instructions)
    )
      invalidSegment(
        'A coordinator rollover requires an exact settled turn and a new frozen context packet.',
      );
  } else {
    if (
      !same(previous.messages, next.messages.slice(0, previous.messages.length)) ||
      !same(
        previous.intermediateNotes || [],
        (next.intermediateNotes || []).slice(0, previous.intermediateNotes?.length || 0),
      )
    )
      invalidSegment('An active work segment cannot erase conversation or note provenance.');
    if (
      after.active.index !== before.active.index ||
      after.active.startedAtRequest !== before.active.startedAtRequest
    )
      invalidSegment('The active work segment cannot change without an archive.');
    if (same(before.anchor, after.anchor)) {
      if (after.active.toolRounds < before.active.toolRounds)
        invalidSegment('The active work step cannot reset its tool-round count.');
    } else if (
      before.anchor.turnId === after.anchor.turnId ||
      after.active.toolRounds !== 0 ||
      next.requests !== previous.requests ||
      after.anchor.scopeRevision !== next.scopeRevisions.at(-1)!.revision
    )
      invalidSegment('Only an explicit new turn can refresh the frozen work-step task.');
  }
}

/** Private checkpoints live separately from public project state and exported events. */
export class FileManagedSessions implements ManagedSessionStore {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }
  private filename(id: string) {
    if (!/^M-[A-Za-z0-9_-]{1,160}$/.test(id))
      throw new DomainError('INVALID_SESSION_ID', 'Invalid managed session ID.');
    return path.join(this.directory, id + '.json');
  }
  private async prepare() {
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new DomainError('UNSAFE_CHECKPOINT', 'Checkpoint storage cannot contain symlinks.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.realpath(this.directory)) !== this.directory)
      throw new DomainError('UNSAFE_CHECKPOINT', 'Checkpoint storage cannot contain symlinks.');
    await fs.chmod(this.directory, 0o700);
  }
  async load(id: string) {
    const filename = this.filename(id);
    await this.queue;
    await this.prepare();
    return this.read(filename, id);
  }
  private async read(filename: string, id: string) {
    try {
      if ((await fs.lstat(filename)).isSymbolicLink())
        throw new DomainError('UNSAFE_CHECKPOINT', 'A checkpoint cannot be a symlink.');
      const session = schema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
      if (session.id !== id)
        throw new DomainError('INVALID_CHECKPOINT', 'Checkpoint identity mismatch.');
      validateSegmentCheckpoint(session);
      return session as ManagedSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  save(session: ManagedSession) {
    const filename = this.filename(session.id);
    const next = schema.parse(structuredClone(session));
    validateSegmentCheckpoint(next);
    const bytes = JSON.stringify(next);
    const work = this.queue.then(async () => {
      await this.prepare();
      validateTransition(await this.read(filename, next.id), next);
      const temp = filename + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, filename);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
