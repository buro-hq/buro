import { t } from '../../i18n/index.ts';
import { Button, Checkbox, Modal, MultiSelect, Textarea } from '@mantine/core';
import { Pencil, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Goal, Run } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { Notice } from '../atoms/Notice';
import { GoalModal } from './GoalModal';
import { PolicySummary } from './PolicySummary';
export function RunRecoveryPanel({
  run,
  compact = false,
  onResumed,
}: {
  run: Run;
  compact?: boolean;
  onResumed?: (id: string) => void;
}) {
  const { snapshot, client, connection } = useProject();
  const [mode, setMode] = useState<'repair' | 'recheck' | null>(null),
    [instructions, setInstructions] = useState(''),
    [currentProfile, setCurrentProfile] = useState(false),
    [ids, setIds] = useState(run.checkIds || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [editing, setEditing] = useState<Goal | null>(null);
  if (
    !run.goalId ||
    !run.status ||
    !['failed', 'interrupted', 'needs-attention'].includes(run.status)
  )
    return null;
  const goal = snapshot?.goals.find((g) => g.id === run.goalId),
    actions = new Set(run.stop?.actions || []),
    policy = currentProfile
      ? snapshot?.executionPolicy
      : run.executionPolicySnapshot || snapshot?.executionPolicy;
  const blocked = snapshot?.runs.some(
    (r) => r.status && ['queued', 'running', 'canceling'].includes(r.status),
  );
  async function resume() {
    if (!mode || !actions.has(mode) || blocked || connection !== 'connected') return;
    setBusy(true);
    setError('');
    try {
      const result = await client!.command<{ runId: string }>({
        method: 'run.resume',
        params: {
          projectId: snapshot!.project.id,
          runId: run.id,
          mode: mode!,
          instructions,
          checkIds: ids,
          useCurrentProfile: currentProfile,
        },
      });
      setMode(null);
      onResumed?.(result.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function startNew() {
    if (!actions.has('new-run') || blocked || connection !== 'connected') return;
    setBusy(true);
    setError('');
    try {
      const result = await client!.command<{ runId: string }>({
        method: 'run.start',
        params: {
          projectId: snapshot!.project.id,
          goalId: run.goalId!,
          checkIds: snapshot!.executionPolicy!.defaultCheckIds,
        },
      });
      onResumed?.(result.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={compact ? 'recovery-actions' : 'recovery-panel'}>
      {!compact && (
        <>
          <h3>{t('Continue work')}</h3>
          <Notice tone={run.issue ? 'warning' : 'info'}>
            {run.stop
              ? t(run.stop.message)
              : t('Recovery actions are unavailable. Refresh the service connection.')}
          </Notice>
        </>
      )}
      {compact && run.stop && <Notice tone="warning">{t(run.stop.message)}</Notice>}
      {run.stop?.detail && <p className="caption">{t(run.stop.detail)}</p>}
      {!compact && <PolicySummary policy={run.effectivePolicy} />}
      <div className="recovery-buttons">
        {actions.has('repair') && (
          <Button
            variant="light"
            size="xs"
            leftSection={<Play size={13} />}
            disabled={blocked || connection !== 'connected'}
            onClick={() => setMode('repair')}
          >
            {t('Continue')}
          </Button>
        )}
        {actions.has('recheck') && (
          <Button
            variant="default"
            size="xs"
            leftSection={<RefreshCw size={13} />}
            disabled={blocked || connection !== 'connected'}
            onClick={() => setMode('recheck')}
          >
            {t('Rerun checks')}
          </Button>
        )}
        {actions.has('new-run') && (
          <Button
            variant="default"
            size="xs"
            leftSection={<Play size={13} />}
            loading={busy}
            disabled={
              blocked ||
              connection !== 'connected' ||
              !snapshot?.executionPolicy?.defaultCheckIds.length
            }
            onClick={() => void startNew()}
          >
            {t('Start new run')}
          </Button>
        )}
        {goal && actions.has('edit-goal') && (
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            leftSection={<Pencil size={13} />}
            disabled={blocked || connection !== 'connected'}
            onClick={() => setEditing(goal)}
          >
            {t('Edit goal')}
          </Button>
        )}
      </div>
      {actions.has('project-settings') && (
        <p className="caption">{t('Project settings can be updated for a new run.')}</p>
      )}
      <Modal
        opened={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'recheck' ? t('Rerun checks') : t('Continue run')}
        size="lg"
        centered
      >
        <div className="goal-form">
          <Notice>
            {t('The same workspace is used. Previous events and results are preserved.')}
          </Notice>
          {run.managedBudget && (
            <Notice>
              {t(
                'This run keeps its original budget, even when current project settings are selected.',
              )}
            </Notice>
          )}
          {goal?.repairEnvironment && (
            <Notice>
              {t(
                'Environment repair is allowed for this goal. Dependencies will be isolated before continuing.',
              )}
            </Notice>
          )}
          {mode === 'repair' && (
            <Textarea
              label={t('Clarification (optional)')}
              value={instructions}
              onChange={(e) => setInstructions(e.currentTarget.value)}
              minRows={4}
              placeholder={t('Describe how to continue the result')}
            />
          )}
          <Checkbox
            label={t('Use current project settings')}
            description={t(
              'Off: keep the original run profile. On: use the commands and boundaries from current project settings.',
            )}
            checked={currentProfile}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              setCurrentProfile(checked);
              setIds(
                checked ? snapshot?.executionPolicy?.defaultCheckIds || [] : run.checkIds || [],
              );
            }}
          />
          <MultiSelect
            searchable
            label={t('Acceptance checks')}
            data={policy?.checks.map((c) => ({ value: c.id, label: c.title })) || []}
            value={ids}
            onChange={setIds}
          />
          {currentProfile && snapshot?.profile && (
            <div className="caption">
              {t('Profile v')}
              {snapshot.profile.revision}
              {snapshot.profile.checks
                .filter((c) => ids.includes(c.id))
                .map((c) => (
                  <code className="source-path" key={c.id}>
                    {c.command}
                  </code>
                ))}
            </div>
          )}
          {error && <Notice tone="error">{t(error)}</Notice>}
          <div className="form-actions">
            <Button variant="default" onClick={() => setMode(null)}>
              {t('Cancel')}
            </Button>
            <Button
              loading={busy}
              disabled={
                blocked || connection !== 'connected' || !ids.length || !mode || !actions.has(mode)
              }
              onClick={() => void resume()}
            >
              {mode === 'recheck' ? t('Check saved result') : t('Continue')}
            </Button>
          </div>
        </div>
      </Modal>
      {editing && (
        <GoalModal
          key={editing.id + String(editing.revision)}
          opened
          goal={editing}
          onClose={() => setEditing(null)}
          onCreated={() => setEditing(null)}
        />
      )}
    </div>
  );
}
