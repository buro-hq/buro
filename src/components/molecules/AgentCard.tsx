import { t } from '../../i18n/index.ts';
import { ArrowUpRight, Check, Clock3 } from 'lucide-react';
import { agentState, seconds, type Agent, type RoleView, type Run } from '../../model';
import { shortCommand, statusLabel } from '../../ui/format';
import { RoleIcon } from '../atoms/RoleIcon';

export function AgentCard({
  agent: a,
  desk = false,
  run,
  cursor,
  roles,
  onAgent: setAgentDetail,
}: {
  agent: Agent;
  desk?: boolean;
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
  onAgent: (id: string) => void;
}) {
  const state = agentState(run, a, cursor),
    role = roles[a.name],
    last = run.commands
      .filter((c) => c.threadId === a.threadId && seconds(run.createdAt, c.startedAt) <= cursor)
      .at(-1);
  return (
    <button
      key={a.threadId}
      className={`${desk ? 'desk' : 'rail-agent'} agent-${a.name} state-${state}`}
      onClick={() => setAgentDetail(a.threadId)}
      style={{ '--agent-color': role.color } as React.CSSProperties}
      aria-label={t('Open agent {p0}', { p0: a.name })}
    >
      <div className="agent-card-head">
        <span className="agent-avatar">
          <RoleIcon kind={role.definition?.kind} />
          <i />
        </span>
        <span className="agent-name">
          <b>{role.title}</b>
          <small>{a.name}</small>
        </span>
        <span className={`agent-status ${state}`}>
          {state === 'working' ? (
            <span className="activity-dots">
              <i />
              <i />
              <i />
            </span>
          ) : state === 'done' ? (
            <Check size={13} />
          ) : (
            <Clock3 size={13} />
          )}
        </span>
      </div>
      {desk && (
        <>
          <div className="desk-monitor">
            <span className="desk-monitor-top">
              <i />
              <i />
              <i />
              <small>{role.owns}</small>
            </span>
            <div className="monitor-lines">
              <i />
              <i />
              <i />
            </div>
            <span className="monitor-command">
              {state === 'waiting'
                ? t('Waiting for its turn')
                : state === 'done'
                  ? t('Work handed off')
                  : last
                    ? shortCommand(last.command)
                    : t('Reading the task and context')}
            </span>
          </div>
          <div className="desk-bottom">
            <span className={`tiny-dot ${state}`} />
            {statusLabel[state]}
            <ArrowUpRight size={12} />
          </div>
          <span className="desk-legs" />
        </>
      )}
      {!desk && <span className="rail-agent-state">{statusLabel[state]}</span>}
    </button>
  );
}
