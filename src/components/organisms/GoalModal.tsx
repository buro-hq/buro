import { t } from '../../i18n/index.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../../protocol/domain.ts';
import { Button, Checkbox, Modal, TextInput, Textarea, Select } from '@mantine/core';
import type { GoalOutcome } from '../../../protocol/operations';
import { Box, FileText, Target } from 'lucide-react';
import { useState } from 'react';
import type { Goal } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { ContextMaterialsEditor } from './ContextMaterialsEditor';
import { Notice } from '../atoms/Notice';
export function GoalModal({
  opened,
  onClose,
  onCreated,
  goal,
}: {
  goal?: Goal;
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { snapshot, client, mode } = useProject();
  const [title, setTitle] = useState(goal?.title || ''),
    [body, setBody] = useState(goal?.body || ''),
    [criteria, setCriteria] = useState(goal?.criteria || ''),
    [materialIds, setMaterialIds] = useState<string[]>(goal?.materialIds || []),
    [repairEnvironment, setRepairEnvironment] = useState(!!goal?.repairEnvironment),
    [parentRunId, setParentRunId] = useState(goal?.parentRunId || ''),
    [outcome, setOutcome] = useState(
      goal?.outcome?.kind === 'deploy'
        ? 'deploy:' + goal.outcome.environmentId
        : goal?.outcome?.kind || 'pull-request',
    ),
    [saving, setSaving] = useState(false),
    [materialsBusy, setMaterialsBusy] = useState(false),
    [error, setError] = useState('');
  const supportsEnvironmentRepair =
    mode === 'replay' || !!snapshot?.capabilities.includes('goal.environment-repair');
  async function save() {
    if (!snapshot || !client) return;
    setSaving(true);
    setError('');
    try {
      const result: GoalOutcome = outcome.startsWith('deploy:')
        ? { kind: 'deploy', environmentId: outcome.slice(7) }
        : { kind: outcome as 'local' | 'pull-request' };
      const options = { ...(parentRunId ? { parentRunId } : {}), outcome: result, materialIds };
      if (goal)
        await client.command({
          method: 'goal.update',
          params: {
            projectId: snapshot.project.id,
            id: goal.id,
            expectedRevision: goal.revision || 1,
            title: title.trim(),
            body: body.trim(),
            criteria: criteria.trim(),
            ...options,
            ...(supportsEnvironmentRepair ? { repairEnvironment } : {}),
          },
        });
      else
        await client.createGoal({
          projectId: snapshot.project.id,
          title: title.trim(),
          body: body.trim(),
          criteria: criteria.trim(),
          ...options,
          ...(supportsEnvironmentRepair ? { repairEnvironment } : {}),
        });
      setTitle('');
      setBody('');
      setCriteria('');
      setMaterialIds([]);
      setRepairEnvironment(false);
      setParentRunId('');
      setOutcome('pull-request');
      onClose();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <span className="modal-title">
          <Target size={18} />
          {goal ? t('Edit goal') : t('New project goal')}
        </span>
      }
      size="lg"
      centered
    >
      <form
        className="goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-project">
          <Box size={16} />
          {snapshot?.project.name}
          <span className="muted">{t('/ goals')}</span>
        </div>
        <TextInput
          label={t('What should we achieve?')}
          placeholder={t('For example, add event log search')}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          required
          data-autofocus
          maxLength={200}
        />
        <Textarea
          label={t('Context and expected result')}
          placeholder={t('Describe the problem and expected behavior')}
          minRows={4}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          required
          maxLength={16000}
        />
        <Textarea
          label={t('How will we know it is done?')}
          placeholder={t('Acceptance criteria')}
          minRows={3}
          value={criteria}
          onChange={(e) => setCriteria(e.currentTarget.value)}
          maxLength={8000}
        />
        <ContextMaterialsEditor
          projectId={snapshot?.project.id}
          root={snapshot?.project.root}
          scope="goal"
          value={materialIds}
          onChange={setMaterialIds}
          onBusyChange={setMaterialsBusy}
        />
        <Select
          label={t('Goal starting point')}
          description={t(
            'Use the base branch by default. A parent run continues a specific accepted result.',
          )}
          value={parentRunId || 'base'}
          allowDeselect={false}
          onChange={(v) => setParentRunId(v === 'base' ? '' : v || '')}
          data={[
            {
              value: 'base',
              label: t('Base branch: {p0}', { p0: snapshot?.profile?.baseBranch || 'HEAD' }),
            },
            ...(snapshot?.runs || [])
              .filter((r) => r.status === 'completed' && r.commit)
              .map((r) => ({
                value: r.id,
                label: `${r.title} · ${r.id.slice(0, 10)} · ${r.commit!.slice(0, 7)}`,
              })),
          ]}
        />
        <Select
          label={t('Work with the completed result')}
          description={t(
            'A completed goal means the implementation is ready. PR and delivery failures are tracked separately.',
          )}
          value={outcome}
          allowDeselect={false}
          onChange={(v) => setOutcome(v || 'pull-request')}
          data={[
            { value: 'pull-request', label: t('Draft PR — default') },
            { value: 'local', label: t('Local result') },
            ...(snapshot?.profile?.delivery?.environments || []).map((e) => ({
              value: 'deploy:' + e.id,
              label: t('Delivery: {p0}{p1}', {
                p0: e.name,
                p1: e.requireConfirmation ? t(' · confirmation required') : '',
              }),
              disabled: !e.enabled,
            })),
          ]}
        />
        {outcome === 'pull-request' && !snapshot?.profile?.delivery?.pullRequests && (
          <p className="caption">
            {t(
              'PR creation is not enabled in project settings yet. Implementation can finish while delivery waits for configuration.',
            )}
          </p>
        )}
        <Checkbox
          label={t('Allow environment repair')}
          description={
            supportsEnvironmentRepair
              ? t(
                  'Agents may repair dependencies and lockfiles. Packages are installed in a separate workspace; check commands remain unchanged.',
                )
              : t('This requires an updated service and a connected Node project.')
          }
          checked={repairEnvironment}
          disabled={!supportsEnvironmentRepair}
          onChange={(event) => setRepairEnvironment(event.currentTarget.checked)}
        />
        <p className="caption">
          {t('No total time limit. Stop after')} {DEFAULT_IDLE_TIMEOUT_MS / 60000}{' '}
          {t('minutes without coordinator or agent progress.')}
        </p>
        <Notice>
          <FileText size={16} />
          {mode === 'service'
            ? t(
                'The goal will be saved in the project. Choose checks and start the team after saving.',
              )
            : t(
                'The draft will be saved in this browser. Connect to the local service to execute it.',
              )}
        </Notice>
        {error && <Notice tone="error">{t(error)}</Notice>}
        <div className="form-actions">
          <Button variant="default" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabled={materialsBusy || !title.trim() || !body.trim()}
          >
            {t('Save goal')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
