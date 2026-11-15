import { t } from '../../i18n/index.ts';
import { ArrowRight, Grip, Network, Target, Users } from 'lucide-react';
import { getRunViewState } from '../../features/runs/view-model';
import { allMilestones, type Agent, type Milestone, type RoleView, type Run } from '../../model';
import { compactKey } from '../../ui/format';

import { AgentCard } from '../molecules/AgentCard';
import { EventRow } from '../molecules/EventRow';

export function RunOffice({
  run,
  cursor,
  roles,
  projectName,
  onAgent: setAgentDetail,
  onInspect: inspect,
  onViewTimeline,
}: {
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
  projectName: string;
  onAgent: (id: string) => void;
  onInspect: (event: Milestone) => void;
  onViewTimeline: () => void;
}) {
  const { complete, currentPhase, active } = getRunViewState(run, cursor);
  const milestones = allMilestones(run, cursor, false, roles);
  const agentCard = (a: Agent, desk = false) => (
    <AgentCard
      key={a.threadId}
      agent={a}
      desk={desk}
      run={run}
      cursor={cursor}
      roles={roles}
      onAgent={setAgentDetail}
    />
  );
  const eventRow = (m: Milestone, i: number, compact = false) => (
    <EventRow
      key={i}
      event={m}
      index={i}
      compact={compact}
      run={run}
      roles={roles}
      onInspect={inspect}
    />
  );
  return (
    <>
      <div className="office-heading">
        <div>
          <h2>
            {t('Project office')}{' '}
            <span className="subtle-label">
              / {String(run.agents.length + 1).padStart(2, '0')} {t('desks')}
            </span>
          </h2>
          <p>{t('Each agent owns a part. The result belongs to the team.')}</p>
        </div>
        <span className="office-presence">
          <i />
          {active} {t('working')}
        </span>
      </div>
      <div className={`office-canvas ${run.agents.length > 3 ? 'many-agents' : ''}`}>
        <div className="office-grid" />
        <div className="room-label">
          <span className="room-square" /> {projectName.toUpperCase()} <span>AGENT WORKSPACE</span>
        </div>
        <span className="office-coordinate">X: 024 · Y: 008</span>
        <svg
          className="office-connections"
          viewBox="0 0 900 440"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M 300 220 L 300 110 Q 300 100 310 100 L 560 100" />
          <path d="M 300 250 L 300 350 Q 300 360 310 360 L 560 360" />
          <path d="M 660 175 L 660 285" />
          {active > 0 && (
            <path className="flow-path" d="M 300 220 L 300 110 Q 300 100 310 100 L 560 100" />
          )}
        </svg>
        <button
          className="coordinator-desk"
          aria-label={t('Open agent coordinator')}
          onClick={() => setAgentDetail('coordinator')}
        >
          <span className="desk-label">{t('ORCHESTRATION')}</span>
          <div className="coordinator-avatar">
            <Network size={28} />
          </div>
          <b>{t('Coordinator')}</b>
          <span className="mono">/root</span>
          <div className="coordinator-task">
            <span className="tiny-dot working" />
            {complete
              ? run.status && run.status !== 'completed'
                ? t('Needs help')
                : t('Result assembled')
              : currentPhase === t('Planning')
                ? t('Planning the work')
                : currentPhase === t('Review')
                  ? t('Collecting reviews')
                  : t('Tracking execution')}
          </div>
          <span className="coordinator-goal">
            <Target size={12} />
            {compactKey(run.key)}
          </span>
        </button>
        <div className={`office-team ${run.agents.length > 3 ? 'many-agents' : ''}`}>
          {run.agents.map((agent, index) => (
            <div className="desk-zone" key={agent.threadId}>
              <div className="desk-zone-label">
                <Users size={12} />
                {roles[agent.name].title.toUpperCase()}
                <span>{String(index + 1).padStart(2, '0')}</span>
              </div>
              {agentCard(agent, true)}
            </div>
          ))}
        </div>
        <div className="office-legend">
          <span>
            <i className="tiny-dot working" />
            {t('Working')}
          </span>
          <span>
            <i className="tiny-dot done" />
            {t('Completed')}
          </span>
          <span>
            <i className="tiny-dot waiting" />
            {t('Waiting')}
          </span>
        </div>
        <div className="office-room-footer">
          <Grip size={13} /> {t('Click a desk for agent details')}
        </div>
      </div>
      <div className="office-feed">
        <div className="section-heading">
          <h3>{t('Office activity')}</h3>
          <button className="text-button" onClick={onViewTimeline}>
            {t('Full timeline')} <ArrowRight size={14} />
          </button>
        </div>
        {milestones.slice(-3).map((m, i) => eventRow(m, i, true))}
        {!milestones.length && (
          <p className="empty">{t('The recording has not started. Click Continue.')}</p>
        )}
      </div>
    </>
  );
}
