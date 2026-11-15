import type { Run } from './domain.ts';
import { activeDuration, executionIntervals, wallDuration } from './timing.ts';
/** Phase times are wall time intersected with active attempts; nested operation timers are reported separately. */
export function runPerformance(run: Run, now = Date.now()) {
  const end = wallDuration(run, now);
  const phases = new Map<string, number>();
  const events = [...run.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const offset = (at: string) =>
    Math.max(0, Math.min(end, (Date.parse(at) - Date.parse(run.createdAt)) / 1000));
  for (const window of executionIntervals(run, end)) {
    let phase = window.start === 0 ? 'queued' : 'restoring',
      start = window.start;
    const close = (at: number) => {
      phases.set(phase, (phases.get(phase) || 0) + Math.max(0, at - start));
      start = at;
    };
    for (const event of events) {
      const at = offset(event.at);
      if (at < window.start || at > window.end || !event.type.startsWith('phase.')) continue;
      close(at);
      phase = event.type.slice(6);
    }
    close(window.end);
  }
  const operations = new Map<string, { calls: number; totalMs: number; maxMs: number }>();
  for (const event of events) {
    if (
      !['performance.measured', 'environment.ready'].includes(event.type) ||
      event.durationMs === undefined
    )
      continue;
    const name =
      event.type === 'environment.ready' ? 'environment.prepare' : event.text || 'unknown';
    const row = operations.get(name) || { calls: 0, totalMs: 0, maxMs: 0 };
    row.calls++;
    row.totalMs += event.durationMs;
    row.maxMs = Math.max(row.maxMs, event.durationMs);
    operations.set(name, row);
  }
  return {
    activeSeconds: activeDuration(run, end),
    wallSeconds: end,
    phases: [...phases].map(([phase, seconds]) => ({ phase, seconds })),
    operations: [...operations].map(([operation, values]) => ({ operation, ...values })),
  };
}
