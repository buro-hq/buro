import type { Agent, Run } from './domain.ts';
export type TimeInterval = { start: number; end: number; open?: boolean; estimated?: boolean };
const terminalEvents = new Set([
  'goal.completed',
  'run.failed',
  'run.interrupted',
  'run.needs-attention',
]);
const running = (run: Run) =>
  !!run.status && ['queued', 'running', 'canceling'].includes(run.status);
const offset = (run: Run, at: string) => (Date.parse(at) - Date.parse(run.createdAt)) / 1000;
export function wallDuration(run: Run, now = Date.now()) {
  const end =
    run.completedAt ||
    (running(run) ? new Date(now).toISOString() : run.updatedAt || run.createdAt);
  return Math.max(0.1, offset(run, end) || 0);
}
/** Wall-clock intervals while the workflow was running; stopped attempts never bridge a human pause. */
export function executionIntervals(run: Run, end = wallDuration(run)): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  let start: number | undefined = 0;
  for (const event of [...run.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const time = Math.max(0, Math.min(end, offset(run, event.at)));
    if (!Number.isFinite(time)) continue;
    if (event.type === 'run.resume-requested' || event.type === 'run.queued') start ??= time;
    if (terminalEvents.has(event.type) && start !== undefined) {
      intervals.push({ start, end: Math.max(start, time) });
      start = undefined;
    }
  }
  if (start !== undefined) intervals.push({ start, end, ...(running(run) ? { open: true } : {}) });
  return intervals;
}
export function activeDuration(run: Run, time = wallDuration(run)) {
  return executionIntervals(run).reduce(
    (sum, interval) => sum + Math.max(0, Math.min(time, interval.end) - interval.start),
    0,
  );
}
export function skipInactiveTime(run: Run, time: number) {
  for (const interval of executionIntervals(run)) {
    if (time < interval.start) return interval.start;
    if (time <= interval.end) return time;
  }
  return Math.min(time, wallDuration(run));
}
/** Older recordings lack turn-start events: subsequent messages/commands provide a conservative start. */
export function agentIntervals(run: Run, agent: Agent): TimeInterval[] {
  const result: TimeInterval[] = [],
    wallEnd = wallDuration(run);
  const own = run.events.filter((event) => event.threadId === agent.threadId);
  const events = [...run.events]
    .filter((event) => event.threadId === agent.threadId || terminalEvents.has(event.type))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let start: number | undefined = Math.max(0, offset(run, agent.startedAt)),
    estimated = false;
  const close = (end: number) => {
    if (start !== undefined && end >= start)
      result.push({ start, end, ...(estimated ? { estimated: true } : {}) });
    start = undefined;
    estimated = false;
  };
  for (const event of events) {
    const time = Math.max(0, Math.min(wallEnd, offset(run, event.at)));
    if (!Number.isFinite(time)) continue;
    if (terminalEvents.has(event.type)) {
      close(time);
      continue;
    }
    if (['agent.started', 'agent.turn-started'].includes(event.type)) {
      start ??= time;
    } else if (['message', 'command.started'].includes(event.type) && start === undefined) {
      start = time;
      estimated = true;
    } else if (['agent.completed', 'agent.turn-completed'].includes(event.type)) close(time);
  }
  if (start !== undefined) {
    const finish =
      !own.some((event) => ['agent.completed', 'agent.turn-completed'].includes(event.type)) &&
      agent.completedAt
        ? offset(run, agent.completedAt)
        : wallEnd;
    if (running(run) && !agent.completedAt)
      result.push({ start, end: wallEnd, open: true, ...(estimated ? { estimated: true } : {}) });
    else close(Math.min(wallEnd, finish));
  }
  // Intersect with execution windows, including for old incomplete lifecycle records.
  return result.flatMap((interval) =>
    executionIntervals(run, wallEnd).flatMap((window) => {
      const start = Math.max(interval.start, window.start),
        end = Math.min(interval.end, window.end);
      return end > start
        ? [{ ...interval, start, end, open: !!interval.open && !!window.open }]
        : [];
    }),
  );
}
export function agentActiveDuration(run: Run, agent: Agent, time = wallDuration(run)) {
  return agentIntervals(run, agent).reduce(
    (sum, interval) => sum + Math.max(0, Math.min(time, interval.end) - interval.start),
    0,
  );
}

/** Inverse projection for a playback slider measured in execution time. */
export function wallTimeAtActive(run: Run, time: number) {
  let consumed = 0;
  for (const interval of executionIntervals(run)) {
    const length = interval.end - interval.start;
    if (time <= consumed + length) return interval.start + Math.max(0, time - consumed);
    consumed += length;
  }
  return wallDuration(run);
}
