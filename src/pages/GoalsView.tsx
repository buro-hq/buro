import { t } from '../i18n/index.ts';
import { activeDuration } from '../../protocol/timing.ts';
import { ActionIcon } from '@mantine/core';
import { ArrowUpRight, Clipboard, Clock3, Pencil, Plus, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { Goal } from '../../protocol/domain.ts';
import { Notice } from '../components/atoms/Notice';
import { RunStatusBadge } from '../components/molecules/RunStatusBadge';
import { GoalModal } from '../components/organisms/GoalModal';
import { GoalRunAction } from '../components/organisms/GoalRunAction';
import { RunRecoveryPanel } from '../components/organisms/RunRecoveryPanel';
import { useProject } from '../data/provider';
import { clock } from '../model';
import { compactKey } from '../ui/format';
export function GoalsView({
  onNewGoal,
  onSelectRun,
  onRunStarted,
}: {
  onNewGoal: () => void;
  onSelectRun: (id: string) => void;
  onRunStarted: (id: string) => void;
}) {
  const { snapshot, client, mode } = useProject();
  const [error, setError] = useState(''),
    [editing, setEditing] = useState<Goal | null>(null);
  if (!snapshot || !client) return null;
  const drafts = snapshot.goals.filter((g) => g.status === 'draft' || g.status === 'failed'),
    runs = snapshot.runs;
  const count = new Set([...snapshot.goals.map((g) => g.id), ...runs.map((r) => r.goalId || r.id)])
    .size;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError(t('Could not copy the goal.'));
    }
  }
  return (
    <div className="goals-view">
      <div className="section-heading">
        <div>
          <h2>{t('Project goals')}</h2>
          <p className="caption">{t('From intent to a verified change')}</p>
        </div>
        <span className="count-badge">{count}</span>
      </div>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="goal-columns">
        <div>
          <h3 className="column-title">
            <span className="tiny-dot waiting" />
            {t('Drafts')} <span>{drafts.length}</span>
          </h3>
          {drafts.map((goal) => (
            <article className="goal-card draft-card" key={goal.id}>
              <span className="micro">
                {mode === 'service' ? t('PROJECT GOAL') : t('LOCAL DRAFT')}
              </span>
              <h3>{goal.title}</h3>
              <p>{goal.body}</p>
              {goal.criteria && <p className="draft-criteria">{goal.criteria}</p>}
              {goal.repairEnvironment && (
                <p className="caption green-text">{t('Environment repair allowed')}</p>
              )}
              <GoalRunAction goal={goal} onStarted={onRunStarted} />
              {goal.runId && snapshot.runs.find((r) => r.id === goal.runId) && (
                <RunRecoveryPanel
                  compact
                  run={snapshot.runs.find((r) => r.id === goal.runId)!}
                  onResumed={onRunStarted}
                />
              )}
              <div className="draft-actions">
                <button className="text-button" onClick={() => setEditing(goal)}>
                  <Pencil size={13} />
                  {t('Edit')}
                </button>
                <button
                  className="text-button"
                  onClick={() => void copy(`# ${goal.title}\n\n${goal.body}\n\n${goal.criteria}`)}
                >
                  <Clipboard size={13} />
                  {t('Copy')}
                </button>
                <ActionIcon
                  aria-label={t('Delete draft {p0}', { p0: goal.title })}
                  variant="subtle"
                  color="gray"
                  onClick={() =>
                    void client
                      .deleteGoal(snapshot.project.id, goal.id)
                      .catch((e) => setError(e.message))
                  }
                >
                  <X size={14} />
                </ActionIcon>
              </div>
            </article>
          ))}
          <button className="add-goal-card" onClick={onNewGoal}>
            <Plus size={17} />
            {t('Describe a goal')}
          </button>
        </div>
        {runs.length > 0 && (
          <div>
            <h3 className="column-title">
              <span className="tiny-dot done" />
              {t('Runs')} <span>{runs.length}</span>
            </h3>
            {runs.map((run) => (
              <button
                key={run.id}
                className="goal-card accepted-card"
                onClick={() => onSelectRun(run.id)}
              >
                <span className="goal-card-id">
                  <span className="mono">{compactKey(run.key)}</span>
                  <RunStatusBadge run={run} />
                </span>
                <h3>{run.title}</h3>
                <p>{run.summary}</p>
                <div className="goal-card-footer">
                  <span>
                    <Users size={13} />
                    {run.agents.length + 1} {t('agents')}
                  </span>
                  <span>
                    <Clock3 size={13} />
                    {clock(activeDuration(run))}
                  </span>
                  <ArrowUpRight size={15} />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <GoalModal
          key={editing.id + String(editing.revision)}
          goal={editing}
          opened
          onClose={() => setEditing(null)}
          onCreated={() => setEditing(null)}
        />
      )}
    </div>
  );
}
