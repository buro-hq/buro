import { getFormattingLocale, t } from '../../i18n/index.ts';
import { activeDuration } from '../../../protocol/timing.ts';
import { Check, Network, ShieldCheck, SquareTerminal } from 'lucide-react';
import { getRunViewState } from '../../features/runs/view-model';
import { getCheckViewState, type CheckState } from '../../features/runs/check-state.ts';
import { clock, isTerminal, seconds, type Agent, type RoleView, type Run } from '../../model';

import { AgentCard } from '../molecules/AgentCard';

export function RunRail({
  run,
  cursor,
  roles,
  onAgent,
}: {
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
  onAgent: (id: string) => void;
}) {
  const { active } = getRunViewState(run, cursor);
  const evidence = getCheckViewState(run, cursor);
  const stateLabel = (state: CheckState) =>
    state === 'passed'
      ? t('All checks passed')
      : state === 'failed'
        ? t('Some checks failed')
        : state === 'unavailable'
          ? t('Evidence unavailable')
          : state === 'running'
            ? t('Checks running')
            : state === 'not-run'
              ? t('Not run yet')
              : t('awaiting checks');
  const color = (state: CheckState) =>
    state === 'passed' ? 'green-text' : state === 'failed' ? 'orange-text' : 'muted';
  const agentCard = (a: Agent) => (
    <AgentCard
      key={a.threadId}
      agent={a}
      run={run}
      cursor={cursor}
      roles={roles}
      onAgent={onAgent}
    />
  );
  return (
    <aside className="right-rail">
      <div className="rail-section">
        <div className="section-heading">
          <h3>{t('Project team')}</h3>
          <span className="count-badge">{run.agents.length}</span>
        </div>
        <p className="caption">{t('Selected run team')}</p>
        <div className="rail-agents">{run.agents.map((a) => agentCard(a))}</div>
        <div className="coordinator-note">
          <Network size={14} />
          <span>{t('Coordinator integrates the result')}</span>
        </div>
      </div>
      <div className="rail-section">
        <div className="section-heading">
          <h3>{t('At this point')}</h3>
          <span className="mono micro">{clock(activeDuration(run, cursor))}</span>
        </div>
        <div className="metric-row">
          <span>{t('Agents working')}</span>
          <b>
            {active}
            <small> / {run.agents.length}</small>
          </b>
        </div>
        <div className="metric-row">
          <span>{t('Commands completed')}</span>
          <b>
            {
              run.commands.filter(
                (c) => c.completedAt && seconds(run.createdAt, c.completedAt) <= cursor,
              ).length
            }
          </b>
        </div>
        {evidence.commands.length > 0 && (
          <div className="metric-row">
            <span>{t('Agent test commands')}</span>
            <b className={color(evidence.project)}>{stateLabel(evidence.project)}</b>
          </div>
        )}
        <div className="metric-row">
          <span>{t('External acceptance')}</span>
          <b className={color(evidence.acceptance)}>
            {stateLabel(evidence.acceptance)}
            {evidence.rows.length ? ` · ${evidence.passed} / ${evidence.total}` : ''}
          </b>
        </div>
      </div>
      <div className="rail-section">
        <div className="section-heading">
          <h3>{t('Office rules')}</h3>
          <ShieldCheck size={14} />
        </div>
        <ul className="rules-list">
          <li>
            <Check size={13} /> {t('Separate file ownership')}
          </li>
          <li>
            <Check size={13} />{' '}
            {run.roleSnapshots?.some((r) => r.kind === 'testing')
              ? t('Dedicated testing role')
              : t('Verified roles for each task')}
          </li>
          <li>
            <Check size={13} /> {t('Fresh reviewer after implementation')}
          </li>
          <li>
            <Check size={13} /> {t('Acceptance outside the workspace')}
          </li>
        </ul>
      </div>
      <div className="rail-source">
        <span className="source-icon">
          <SquareTerminal size={17} />
        </span>
        <div>
          <b>{t('Real CLI events')}</b>
          <p>
            {run.events.length} {t('events ·')}{' '}
            {new Date(run.createdAt).toLocaleDateString(getFormattingLocale(), {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
          <span>
            {isTerminal(run) ? t('Viewing a saved recording') : t('Live from the service')}
          </span>
        </div>
      </div>
    </aside>
  );
}
