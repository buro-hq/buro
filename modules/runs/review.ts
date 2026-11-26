import { z } from 'zod';
import type { ReviewSettings, RunReview, ReviewCommand } from '#shared/contracts';
import type { SessionResult, Sessions } from '../sessions/session.ts';
import type { ActivityHistory } from '../sessions/activity.ts';
import type { Run } from './run.ts';

const reportSchema = z.object({
  summary: z.string(),
  findings: z.array(z.object({
    message: z.string().min(1),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
  })),
});

/** Persisted review progress remains distinct from the executor's task result. */
export interface ReviewProgress {
  status: string;
  reviews: RunReview[];
  error?: string;
}

/** A review cycle uses the ordinary session loop and inherited run access. */
export interface ReviewInput {
  sessions: Sessions;
  activity: ActivityHistory;
  run: Run;
  prompt: string;
  result: SessionResult;
  configuration: ReviewSettings;
  signal: AbortSignal;
  update(progress: ReviewProgress): Promise<void>;
}

/** Executor output and review outcome can independently succeed or fail. */
export interface ReviewOutcome extends ReviewProgress {
  result: SessionResult;
}

const instructions = [
  'Independently review the actual task result in this workspace.',
  'The implementation summary is a claim, not proof. Inspect the changed files against the supplied base commit.',
  'Run appropriate repository checks when useful and report observed results honestly.',
  'Review source without changing it; build and test artifacts are allowed. Do not publish or apply changes to the source project.',
  'Report only actionable correctness, regression, code-quality or architecture problems within the task scope.',
  'Distinguish confirmed defects from optional preferences. Do not demand speculative abstractions, extra roles or defensive checks without a concrete need.',
  'Use an empty findings list when there is no actionable issue. Never invent findings to fill a quota.',
].join('\n');

const commands = async (input: {
  activity: ActivityHistory;
  sessions: Sessions;
  runId: string;
  sessionId: string;
}): Promise<ReviewCommand[]> => {
  const sessions = await input.sessions.list({
    runId: input.runId,
  });
  const descendants = new Set([input.sessionId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const session of sessions)
      if (session.parentId && descendants.has(session.parentId) && !descendants.has(session.id)) {
        descendants.add(session.id);
        changed = true;
      }
  }
  const observations = await input.activity.list({
    runId: input.runId,
  });
  return observations.flatMap((entry) => {
    const { call, result } = entry.data as {
      call?: { name?: string; arguments?: { command?: string } };
      result?: { isError?: boolean; exitCode?: number };
    };
    const isCommand = call?.name === 'command' || call?.name === 'command_read';
    if (!descendants.has(entry.sessionId) || entry.type !== 'tool.completed' || !isCommand || !call?.arguments?.command)
      return [];

    return [{ command: call.arguments.command, exitCode: result?.exitCode, failed: result?.isError === true }];
  });
};

/** Reviews, returns findings to the executor, and repeats without changing the shared session loop. */
export const reviewRun = async (input: ReviewInput): Promise<ReviewOutcome> => {
  const { sessions, run, configuration, signal } = input;
  const participants = configuration.participants ?? [];
  const reviews: RunReview[] = [];
  let result = input.result;
  const progress = async (status: string, error?: string): Promise<ReviewOutcome> => {
    const outcome = { status, reviews: structuredClone(reviews), result, error };
    await input.update(outcome);
    return outcome;
  };
  if (!participants.length)
    return progress('failed', 'No review participants are configured.');

  try {
    for (let round = 1; ; round++) {
      signal.throwIfAborted();
      const findings: { name: string; summary?: string; findings: NonNullable<RunReview['findings']> }[] = [];
      let failed = false;
      const executor = await sessions.get({
        id: run.sessionId,
      });
      for (const participant of participants) {
        signal.throwIfAborted();
        const created = await sessions.create({
          runId: run.id,
          parentId: run.sessionId,
          modelId: participant.modelId ?? executor?.modelId,
          instructions: [instructions, participant.instructions].filter(Boolean).join('\n\n'),
          policy: executor?.policy,
          access: { readOnly: run.options?.readOnly, tools: run.options?.tools },
        });
        if (!created.ok)
          throw new Error(created.error ?? 'Unable to create a review session.');

        const record: RunReview = {
          sessionId: created.sessionId,
          name: participant.name,
          round,
          status: 'running',
        };
        reviews.push(record);
        await progress('running');
        const scope = run.options?.tools;
        const tools = scope
          ? scope.filter((name) => !participant.tools || participant.tools.includes(name))
          : participant.tools;
        try {
          const inspected = await sessions.run({
            sessionId: record.sessionId,
            input: [input.prompt, `Base commit: ${run.base}`, `Executor summary (verify against evidence):\n${result.text ?? ''}`].join('\n\n'),
            workspace: run.workspace,
            projectId: run.projectId,
            tools,
            readOnly: run.options?.readOnly,
            signal,
          });
          if (!inspected.ok)
            throw new Error(inspected.error ?? 'The review did not complete.');

          const reported = await sessions.run({
            sessionId: record.sessionId,
            input: 'Return only the final review as JSON matching the supplied schema: summary and findings. Include only actionable issues established by the task, files and observed checks. An empty findings array means there are no actionable issues.',
            workspace: run.workspace,
            projectId: run.projectId,
            tools: [],
            schema: z.toJSONSchema(reportSchema),
            readOnly: true,
            signal,
          });
          if (!reported.ok)
            throw new Error(reported.error ?? 'The review report did not complete.');

          const report = reportSchema.parse(JSON.parse(reported.text ?? ''));
          Object.assign(record, report, {
            status: 'completed',
          });
          if (report.findings.length)
            findings.push({
              name: participant.name,
              ...report,
            });
        } catch (error) {
          failed = true;
          record.status = signal.aborted ? 'interrupted' : 'failed';
          record.error = error instanceof Error ? error.message : String(error);
          signal.throwIfAborted();
        } finally {
          record.commands = await commands({
            activity: input.activity,
            sessions,
            runId: run.id,
            sessionId: record.sessionId,
          });
          await sessions.close({
            runId: run.id,
          });
          await progress('running');
        }
      }
      if (!findings.length)
        return progress(failed ? 'failed' : 'completed');

      if (run.options?.readOnly)
        return progress('findings');

      result = await sessions.run({
        sessionId: run.sessionId,
        input: [
          'Independent review found the following issues. Verify them against the current files, fix the substantive problems within the original task scope, and run appropriate checks. Explain any finding you cannot resolve. The team will review the resulting work again.',
          JSON.stringify(findings),
        ].join('\n\n'),
        workspace: run.workspace,
        projectId: run.projectId,
        tools: run.options?.tools,
        readOnly: run.options?.readOnly,
        signal,
      });
      await sessions.close({
        runId: run.id,
      });
      if (!result.ok)
        return progress(result.interrupted ? 'interrupted' : 'failed', result.error);

      if (failed)
        return progress('failed', 'One or more review sessions did not complete.');

      const { maxRounds } = configuration;
      if (maxRounds !== undefined && maxRounds !== null && round >= maxRounds)
        return progress('limited', 'The configured review-round limit was reached after corrections.');
    }
  } catch (error) {
    if (signal.aborted) {
      result = { ...result, ok: false, interrupted: true, error: 'The review cycle was interrupted.' };
      return progress('interrupted', result.error);
    }

    return progress('failed', error instanceof Error ? error.message : String(error));
  }
};
