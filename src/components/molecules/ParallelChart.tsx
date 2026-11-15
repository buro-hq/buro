import { t } from '../../i18n/index.ts';
import { activeDuration, agentIntervals, agentActiveDuration } from '../../../protocol/timing.ts';
import { agentState, clock, duration, type RoleView, type Run } from '../../model';

export function ParallelChart({
  run,
  cursor,
  onAgent,
  roles,
}: {
  run: Run;
  cursor: number;
  onAgent: (name: string) => void;
  roles: Record<string, RoleView>;
}) {
  const wallEnd = duration(run),
    end = Math.max(0.1, activeDuration(run)),
    position = activeDuration(run, cursor),
    paused = Math.max(0, wallEnd - end);
  return (
    <div className="parallel-chart">
      <div className="chart-header">
        <span className="micro">{t('PARALLEL WORK')}</span>
        <span className="micro muted">
          {t('Work')} {clock(end)} {t('· pauses')} {clock(paused)}
        </span>
      </div>
      {run.agents.map((a) => {
        const intervals = agentIntervals(run, a),
          start = intervals[0]?.start ?? 0,
          total = agentActiveDuration(run, a, cursor);
        return (
          <button className="chart-row" key={a.threadId} onClick={() => onAgent(a.threadId)}>
            <span style={{ color: roles[a.name].color }}>{a.name}</span>
            <span className="chart-track">
              {intervals
                .filter((interval) => interval.start <= cursor)
                .map((interval, index) => (
                  <i
                    key={index}
                    title={`${interval.estimated ? t('From recorded events: ') : ''}${clock(interval.end - interval.start)}`}
                    style={{
                      left: `${(activeDuration(run, interval.start) / end) * 100}%`,
                      width: `${(Math.max(0, activeDuration(run, Math.min(interval.end, cursor)) - activeDuration(run, interval.start)) / end) * 100}%`,
                      background: roles[a.name].color,
                    }}
                  />
                ))}
              {cursor >= start && (
                <small
                  style={{ left: `${Math.min(90, (activeDuration(run, start) / end) * 100 + 2)}%` }}
                >
                  {agentState(run, a, cursor) === 'working'
                    ? t('working')
                    : `${intervals.some((interval) => interval.estimated) ? '≈' : ''}${clock(total)}`}
                </small>
              )}
              <span className="chart-cursor" style={{ left: `${(position / end) * 100}%` }} />
            </span>
          </button>
        );
      })}
      <div className="chart-axis">
        <span />
        <span>00:00</span>
        <span>{clock(end / 2)}</span>
        <span>{clock(end)}</span>
      </div>
    </div>
  );
}
