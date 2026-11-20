import type { Check, Command, Run } from '../../../protocol/domain.ts';
import { wallDuration } from '../../../protocol/timing.ts';

export type CheckState =
  | 'not-run'
  | 'pending'
  | 'running'
  | 'unavailable'
  | 'failed'
  | 'passed'
  | 'reviewed';
const terminal = (run: Run) =>
  !run.status || ['completed', 'failed', 'interrupted', 'needs-attention'].includes(run.status);
const offset = (run: Run, at: string) => (Date.parse(at) - Date.parse(run.createdAt)) / 1000;
const isTest = (command: Command) =>
  /\b(?:node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)(?:\s|$)/.test(command.command);

export function commandCheckState(command: Pick<Command, 'completedAt' | 'exitCode'>): CheckState {
  if (!command.completedAt) return 'running';
  if (!Number.isSafeInteger(command.exitCode) || command.exitCode! < 0) return 'unavailable';
  return command.exitCode === 0 ? 'passed' : 'failed';
}

type CriterionState = 'passed' | 'failed' | 'unavailable';
export function criterionCheckState(check: Check): CriterionState {
  if (
    check.exitCode === null ||
    (check.exitCode !== undefined && (!Number.isSafeInteger(check.exitCode) || check.exitCode < 0))
  )
    return 'unavailable';
  if (check.command && check.exitCode === undefined) return 'unavailable';
  if (check.exitCode !== undefined && check.exitCode !== 0) return 'failed';
  if (check.passed && check.error) return 'unavailable';
  return check.passed ? 'passed' : 'failed';
}

/** Only public service observations; terminal lifecycle by itself proves no check or review. */
export function getCheckViewState(run: Run, cursor: number) {
  const at = (type: string) =>
    run.events
      .filter((event) => event.type === type)
      .map((event) => offset(run, event.at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
      .at(-1);
  const visible = (time: number | undefined) => time !== undefined && time <= cursor + 0.01;
  const final = terminal(run) && cursor >= wallDuration(run) - 0.05;
  const resumeAt = at('run.resume-requested');
  const checkStart = at('phase.checking');
  const checkEnd = [at('checks.completed'), at('acceptance')]
    .filter((time): time is number => time !== undefined)
    .sort((a, b) => a - b)
    .at(-1);
  const currentCheck =
    checkEnd !== undefined && checkEnd >= Math.max(checkStart ?? -Infinity, resumeAt ?? -Infinity);
  const acceptanceVisible =
    checkEnd !== undefined ? currentCheck && visible(checkEnd) : final && resumeAt === undefined;
  const currentPhase = run.events
    .filter((event) => event.type.startsWith('phase.') && visible(offset(run, event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .at(-1)?.type;
  const rowStates = acceptanceVisible
    ? run.acceptance.results.map((check) => ({ check, state: criterionCheckState(check) }))
    : [];
  const passed = rowStates.filter((row) => row.state === 'passed').length;
  const expected = Math.max(run.acceptance.total, run.checkIds?.length || 0, rowStates.length);
  let acceptance: CheckState;
  if (acceptanceVisible && rowStates.some((row) => row.state === 'failed')) acceptance = 'failed';
  else if (
    acceptanceVisible &&
    (rowStates.some((row) => row.state === 'unavailable') || rowStates.length < expected)
  )
    acceptance = 'unavailable';
  else if (acceptanceVisible && rowStates.length > 0) acceptance = 'passed';
  else if (currentPhase === 'phase.checking' && !final) acceptance = 'running';
  else
    acceptance =
      expected > 0 && !final
        ? 'pending'
        : expected > 0 && acceptanceVisible
          ? 'unavailable'
          : 'not-run';
  const reviewEnd = at('review.completed');
  const reviewStart = at('phase.review');
  const currentReview =
    reviewEnd !== undefined &&
    reviewEnd >=
      Math.max(
        reviewStart ?? -Infinity,
        resumeAt ?? -Infinity,
        checkStart ?? -Infinity,
        checkEnd ?? -Infinity,
      );
  const reviewVisible =
    reviewEnd !== undefined ? currentReview && visible(reviewEnd) : final && resumeAt === undefined;
  let review: CheckState;
  if (reviewVisible && run.independentReviewer && run.review)
    review =
      run.review.verdict === 'approved' && !run.review.blockingFindings.length
        ? 'reviewed'
        : 'failed';
  else if (reviewVisible && (run.independentReviewer || run.review)) review = 'unavailable';
  else review = currentPhase === 'phase.review' && !final ? 'running' : 'not-run';
  const commands = run.commands
    .filter((command) => isTest(command) && visible(offset(run, command.startedAt)))
    .map((command) => {
      if (command.completedAt && !visible(offset(run, command.completedAt))) {
        const {
          completedAt: _completedAt,
          exitCode: _exitCode,
          output: _output,
          ...started
        } = command;
        return { command: started as Command, state: 'running' as const };
      }
      return { command, state: commandCheckState(command) };
    });
  const project = commands.at(-1)?.state || 'not-run';
  const scopeVisible = acceptanceVisible && (checkEnd !== undefined || rowStates.length > 0);
  const scope: CheckState = !scopeVisible
    ? 'unavailable'
    : run.scopePreserved && run.specsUnchanged
      ? 'passed'
      : 'failed';
  const overall: CheckState =
    acceptance === 'failed' || review === 'failed' || scope === 'failed'
      ? 'failed'
      : acceptance === 'passed' && review === 'reviewed' && scope === 'passed'
        ? 'reviewed'
        : acceptance === 'unavailable' || review === 'unavailable'
          ? 'unavailable'
          : acceptance === 'running' || review === 'running'
            ? 'running'
            : 'pending';
  return {
    acceptance,
    acceptanceVisible,
    rows: rowStates.sort(
      (a, b) =>
        ({ failed: 0, unavailable: 1, passed: 2 })[a.state] -
        { failed: 0, unavailable: 1, passed: 2 }[b.state],
    ),
    passed,
    total: expected,
    review,
    reviewVisible,
    project,
    commands,
    overall,
    scope,
    implementationReady:
      final && run.status === 'completed' && !!run.commit && overall === 'reviewed',
  };
}
