import { t } from '../../i18n/index.ts';
import { Button, Checkbox, Modal, MultiSelect, Textarea } from '@mantine/core';
import { Pencil, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Goal, Run } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { Notice } from '../atoms/Notice';
import { GoalModal } from './GoalModal';
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
    supported = snapshot?.capabilities.includes('run.resume'),
    canRecheck =
      !!run.planSavedAt ||
      !!run.roleSnapshots?.some((role) => !['coordinator', 'reviewer'].includes(role.id)),
    policy = currentProfile
      ? snapshot?.executionPolicy
      : run.executionPolicySnapshot || snapshot?.executionPolicy;
  const blocked = snapshot?.runs.some(
    (r) => r.status && ['queued', 'running', 'canceling'].includes(r.status),
  );
  async function resume() {
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
  return (
    <div className={compact ? 'recovery-actions' : 'recovery-panel'}>
      {!compact && (
        <>
          <h3>{t('Continue work')}</h3>
          <Notice tone={run.issue ? 'warning' : 'info'}>
            {run.issue?.message ||
              t(
                'The workspace and history are preserved. Revise the goal, continue repairs or rerun checks only.',
              )}
          </Notice>
        </>
      )}
      {compact && run.issue && <Notice tone="warning">{run.issue.message}</Notice>}
      <div className="recovery-buttons">
        <Button
          variant="light"
          size="xs"
          leftSection={<Play size={13} />}
          disabled={!supported || blocked || connection !== 'connected' || !run.workspace}
          onClick={() => setMode('repair')}
        >
          {t('Continue')}
        </Button>
        <Button
          variant="default"
          size="xs"
          leftSection={<RefreshCw size={13} />}
          disabled={
            !supported || !canRecheck || blocked || connection !== 'connected' || !run.workspace
          }
          onClick={() => setMode('recheck')}
        >
          {t('Rerun checks')}
        </Button>
        {goal && (
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
      {supported && !canRecheck && (
        <p className="caption">
          {t('No plan has been saved yet. Click Continue to finish planning.')}
        </p>
      )}
      {!supported && (
        <p className="caption">{t('Update the local service to continue saved runs.')}</p>
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
          {goal?.repairEnvironment && (
            <Notice>
              {t(
                'Environment repair is allowed for this goal. Dependencies will be isolated before continuing.',
              )}
            </Notice>
          )}
          {mode === 'repair' && (
            <Textarea
              label={t('What needs to be fixed or clarified?')}
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
              disabled={!ids.length || (mode === 'repair' && !instructions.trim())}
              onClick={() => void resume()}
            >
              {mode === 'recheck' ? t('Check saved result') : t('Continue with clarification')}
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
