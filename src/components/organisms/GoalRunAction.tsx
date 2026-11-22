import { t } from '../../i18n/index.ts';
import { Button, MultiSelect } from '@mantine/core';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Goal, RepositoryInfo } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { PolicySummary } from './PolicySummary';
export function GoalRunAction({
  goal,
  onStarted,
}: {
  goal: Goal;
  onStarted?: (id: string) => void;
}) {
  const { snapshot, client, mode, connection } = useProject();
  const [ids, setIds] = useState(snapshot?.executionPolicy?.defaultCheckIds || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [repository, setRepository] = useState<RepositoryInfo | null>(null);
  useEffect(() => {
    if (snapshot?.project.managed)
      void client!
        .command<RepositoryInfo>({
          method: 'project.info',
          params: { projectId: snapshot.project.id },
        })
        .then(setRepository)
        .catch(() => {});
  }, [client, snapshot?.project.id]);
  const policy = snapshot?.executionPolicy;
  const unresolved = snapshot?.runs.find(
    (run) => run.goalId === goal.id && run.stop?.category === 'unknown',
  );
  useEffect(() => {
    setIds(policy?.defaultCheckIds || []);
  }, [snapshot?.profile?.revision]);
  if (mode !== 'service' || !policy || goal.status === 'running') return null;
  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await client!.command<{ runId: string }>({
        method: 'run.start',
        params: { projectId: snapshot!.project.id, goalId: goal.id, checkIds: ids },
      });
      onStarted?.(result.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="goal-run-action">
      <MultiSelect
        searchable
        label={t('Acceptance checks')}
        data={policy!.checks.map((c) => ({ value: c.id, label: c.title }))}
        value={ids}
        onChange={setIds}
        size="xs"
      />
      {!policy.checks.length && (
        <p className="source-notice">
          {t('Add an acceptance check in Project settings before starting this goal.')}
        </p>
      )}
      {repository && (
        <small>
          {t('Source branch:')} {repository.branch || 'detached HEAD'} ·{' '}
          {repository.head.slice(0, 8)}
        </small>
      )}
      <small>
        {t('Starting point:')}{' '}
        {goal.parentRunId
          ? t('parent run {p0}', { p0: goal.parentRunId })
          : snapshot?.profile?.baseBranch || 'HEAD'}
      </small>
      {repository?.dirty && (
        <p className="source-notice">
          {t('Uncommitted changes stay in the source directory. The goal works from a Git commit.')}
        </p>
      )}
      {goal.repairEnvironment && (
        <small className="green-text">
          {t('Environment repair is allowed for this goal. Dependencies are installed separately.')}
        </small>
      )}
      <PolicySummary policy={snapshot?.effectivePolicy} />
      {unresolved?.stop && <p className="source-notice">{t(unresolved.stop.message)}</p>}
      <Button
        leftSection={<Play size={13} />}
        loading={busy}
        disabled={
          connection !== 'connected' ||
          !!unresolved ||
          !ids.length ||
          snapshot!.runs.some(
            (r) => r.status && ['queued', 'running', 'canceling'].includes(r.status),
          )
        }
        onClick={() => void start()}
      >
        {goal.status === 'failed' ? t('Run again') : t('Start goal')}
      </Button>
      {error && <p role="alert">{t(error)}</p>}
    </div>
  );
}
