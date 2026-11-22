import { roleLabels } from '../../ui/role-labels';
import { t } from '../../i18n/index.ts';
import { operationLabel } from '../../ui/operation-label.ts';
import { roleIdPattern } from '../../../protocol/domain.ts';
import {
  Badge,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { ArrowUpRight, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Role, RoleKind, Run, SaveRole } from '../../../protocol/domain.ts';
import { roleColor } from '../../model';
import { RoleIcon } from '../atoms/RoleIcon';
import { useResourceCatalog } from '../../features/resources/useResourceCatalog';

export function TeamPanel({
  roles,
  run,
  canEdit,
  onSession,
  onSave,
  projectId,
}: {
  roles: Role[];
  run?: Run;
  canEdit: boolean;
  onSession: (id: string) => void;
  onSave: (input: SaveRole) => Promise<unknown>;
  projectId: string;
}) {
  const [editor, setEditor] = useState<Role | 'new' | null>(null);
  const resources = useResourceCatalog(projectId);
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Project team')}</h2>
          <p className="caption">
            {t('The team grows with your work. Roles are reused; each goal gets its own sessions.')}
          </p>
        </div>
        <Button
          size="xs"
          variant="light"
          color="sage"
          disabled={!canEdit}
          leftSection={<Plus size={13} />}
          onClick={() => setEditor('new')}
        >
          {t('New role')}
        </Button>
      </div>
      {!canEdit && (
        <p className="caption">{t('Connect to the local service to edit the catalog.')}</p>
      )}
      {roles.length === 0 && (
        <div className="team-empty" role="status">
          <RoleIcon kind="coordination" />
          <div>
            <Text fw={500} size="sm">
              {t('Your team will appear here')}
            </Text>
            <Text c="dimmed" size="sm">
              {t(
                'Start a goal: the workflow adds its required roles, and the coordinator selects or creates specialists.',
              )}
            </Text>
          </div>
        </div>
      )}
      <div className="team-grid project-team-grid">
        {roles.map((role) => {
          const color = roleColor(role.kind);
          const preference = role.runtimePreference;
          const labels = roleLabels(role);
          const sessionId =
            run &&
            ([...run.agents, ...(run.resultAgents || [])]
              .reverse()
              .find((agent) => agent.name === role.id)?.threadId ||
              (role.id === 'coordinator' && run.threadId ? 'coordinator' : undefined));
          return (
            <div
              key={role.id}
              className="team-role"
              style={{ '--agent-color': color } as React.CSSProperties}
            >
              <div className="role-card-heading">
                <span className="team-role-icon">
                  <RoleIcon kind={role.kind} />
                </span>
                <div className="role-card-title">
                  <h3>{labels.title}</h3>
                  <Text size="xs" c="dimmed">
                    {role.provenance.origin === 'user'
                      ? t('Your role')
                      : role.provenance.origin === 'coordinator'
                        ? t('Created by coordinator')
                        : t('From workflow')}
                  </Text>
                </div>
                <Badge variant="light" color="gray" size="xs">
                  v{role.version}
                </Badge>
              </div>
              <p>{labels.description}</p>
              {run?.roleOrigins?.[role.id] && (
                <Badge size="xs" variant="light" color="sage">
                  {run.roleOrigins[role.id] === 'created'
                    ? t('Created for this goal')
                    : t('Reused')}
                </Badge>
              )}
              <Text size="xs" c="dimmed" className="role-card-model">
                {preference && preference.mode !== 'auto'
                  ? t(preference.mode === 'fixed' ? 'Only: {p0}' : 'Prefer: {p0}', {
                      p0:
                        resources.catalog?.runtimes.find((item) => item.id === preference.runtimeId)
                          ?.model || preference.runtimeId,
                    })
                  : t('Auto model')}
              </Text>
              <div className="role-actions">
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={!sessionId}
                  rightSection={<ArrowUpRight size={14} />}
                  onClick={() => sessionId && onSession(sessionId)}
                >
                  {sessionId ? t('Open session') : t('Not assigned yet')}
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={!canEdit}
                  leftSection={<Pencil size={13} />}
                  aria-label={t('Edit role {p0}', { p0: role.id })}
                  onClick={() => setEditor(role)}
                >
                  {t('Edit')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <Modal
        opened={editor !== null}
        onClose={() => setEditor(null)}
        title={t('Project role')}
        size="lg"
        centered
      >
        {editor && (
          <RoleForm
            key={editor === 'new' ? 'new' : `${editor.id}:${editor.version}`}
            initial={editor === 'new' ? null : editor}
            projectId={projectId}
            resources={resources}
            onSave={async (input) => {
              await onSave(input);
              setEditor(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
function RoleForm({
  initial,
  projectId,
  onSave,
  resources,
}: {
  initial: Role | null;
  projectId: string;
  onSave: (input: SaveRole) => Promise<void>;
  resources: ReturnType<typeof useResourceCatalog>;
}) {
  const [id, setId] = useState(initial?.id || ''),
    [title, setTitle] = useState(initial?.title || ''),
    [description, setDescription] = useState(initial?.description || ''),
    [instructions, setInstructions] = useState(initial?.instructions || ''),
    [kind, setKind] = useState<RoleKind>(initial?.kind || 'general');
  const [preferenceMode, setPreferenceMode] = useState<'auto' | 'prefer' | 'fixed'>(
    initial?.runtimePreference?.mode || 'auto',
  );
  const [runtimeId, setRuntimeId] = useState(
    initial?.runtimePreference && initial.runtimePreference.mode !== 'auto'
      ? initial.runtimePreference.runtimeId
      : '',
  );
  const [operationId, setOperationId] = useState('');
  const exactOperations =
    resources.catalog?.roleChoices?.filter((item) => item.roleId === id) || [];
  const roleOperations = exactOperations.length
    ? exactOperations
    : resources.catalog?.roleChoices?.filter((item) => item.roleId === '*') || [];
  const roleChoices =
    roleOperations.find((item) => item.operationId === operationId) || roleOperations[0];
  const modelOptions = (roleChoices?.choices || []).map(({ resource: runtime, eligible }) => ({
    value: runtime.id,
    label: `${runtime.model || runtime.id} · ${runtime.id}${eligible ? '' : ' · ' + t('Unavailable')}`,
    disabled: !eligible,
  }));
  const selectedChoice = roleChoices?.choices.find((item) => item.resource.id === runtimeId);
  const eligibleForAnyOperation = roleOperations.some((operation) =>
    operation.choices.some((choice) => choice.resource.id === runtimeId && choice.eligible),
  );
  const otherUnavailable = roleOperations
    .filter((operation) => operation !== roleChoices)
    .flatMap((operation) => {
      const choice = operation.choices.find((item) => item.resource.id === runtimeId);
      return choice && !choice.eligible ? [{ operation, reason: choice.reason }] : [];
    });
  if (runtimeId && !modelOptions.some((item) => item.value === runtimeId))
    modelOptions.push({
      value: runtimeId,
      label: runtimeId + ' · ' + t('Unavailable'),
      disabled: true,
    });
  const [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        projectId,
        id,
        title,
        description,
        instructions,
        kind,
        expectedVersion: initial?.version || 0,
        ...(initial?.model ? { model: initial.model } : {}),
        runtimePreference:
          preferenceMode === 'auto' ? { mode: 'auto' } : { mode: preferenceMode, runtimeId },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="goal-form role-form">
      {initial && (
        <Text size="sm" c="dimmed">
          {initial.provenance.origin === 'user'
            ? t('Your instructions and model preference are reused for new work.')
            : t('This role was added automatically. Your edits take priority for new work.')}
        </Text>
      )}
      <TextInput
        label={t('Role ID')}
        placeholder="browser_debugger"
        description={t('Lowercase Latin letters, digits, underscores and hyphens')}
        disabled={!!initial}
        value={id}
        onChange={(e) => setId(e.currentTarget.value)}
        required
      />
      <TextInput
        label={t('Role name')}
        placeholder={t('UI verifier')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        required
      />
      <Textarea
        label={t('When to use')}
        placeholder={t('Tasks this specialist can handle')}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        minRows={2}
        required
      />
      <Select
        label={t('Specialization')}
        value={kind}
        onChange={(v) => setKind(v as RoleKind)}
        allowDeselect={false}
        data={[
          { value: 'general', label: t('General') },
          { value: 'implementation', label: t('Development') },
          { value: 'testing', label: t('Checks') },
          { value: 'review', label: t('Review') },
          { value: 'coordination', label: t('Coordination') },
        ]}
      />
      <Textarea
        label={t('Persistent instructions')}
        placeholder={t(
          'Define the specialist behavior. The specific task is provided on assignment.',
        )}
        value={instructions}
        onChange={(e) => setInstructions(e.currentTarget.value)}
        minRows={5}
        required
      />
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {t('Specialist model')}
        </Text>
        <>
          {roleOperations.length > 1 ? (
            <Select
              label={t('Used for')}
              value={roleChoices?.operationId || null}
              data={roleOperations.map((operation) => ({
                value: operation.operationId,
                label: operationLabel(operation.operationLabel),
              }))}
              onChange={(value) => setOperationId(value || '')}
              allowDeselect={false}
              disabled={resources.loading}
            />
          ) : (
            roleChoices && (
              <Text size="xs" c="dimmed">
                {operationLabel(roleChoices.operationLabel)}
              </Text>
            )
          )}
          <SegmentedControl
            aria-label={t('Model selection')}
            size="xs"
            value={preferenceMode}
            onChange={(value) => setPreferenceMode(value as typeof preferenceMode)}
            data={[
              { value: 'auto', label: t('Auto') },
              { value: 'prefer', label: t('Prefer') },
              { value: 'fixed', label: t('Only this model') },
            ]}
          />
          {preferenceMode !== 'auto' && (
            <Select
              label={t('Model from project pool')}
              value={runtimeId || null}
              onChange={(value) => setRuntimeId(value || '')}
              data={modelOptions}
              renderOption={({ option }) => {
                const choice = roleChoices?.choices.find(
                  (item) => item.resource.id === option.value,
                );
                return (
                  <Stack gap={2}>
                    <Text size="sm">{option.label}</Text>
                    {choice && !choice.eligible && (
                      <Text size="xs" c="dimmed">
                        {t(choice.reason)}
                      </Text>
                    )}
                  </Stack>
                );
              }}
              searchable
              allowDeselect={false}
              disabled={!resources.catalog || resources.loading}
              nothingFoundMessage={t('No models in this project pool')}
              required
            />
          )}
          {preferenceMode !== 'auto' && selectedChoice && !selectedChoice.eligible && (
            <Text size="xs" c="orange">
              {operationLabel(roleChoices!.operationLabel)}: {t(selectedChoice.reason)}
            </Text>
          )}
          {preferenceMode !== 'auto' &&
            otherUnavailable.map(({ operation, reason }) => (
              <Text key={operation.operationId} size="xs" c="orange">
                {operationLabel(operation.operationLabel)}: {t(reason)}
              </Text>
            ))}
          {roleOperations.length > 1 && (
            <Text size="xs" c="dimmed">
              {t(
                'This preference applies to every use of the role. Availability depends on the selected operation.',
              )}
            </Text>
          )}
          {resources.supported && (!resources.catalog || resources.error) && (
            <Group gap="xs">
              <Text
                size="xs"
                c={resources.error ? 'red' : 'dimmed'}
                role={resources.error ? 'alert' : 'status'}
              >
                {resources.error || t('Loading project models…')}
              </Text>
              <Button
                size="xs"
                variant="light"
                loading={resources.loading}
                onClick={() => void resources.refresh()}
              >
                {t('Refresh')}
              </Button>
            </Group>
          )}
          <Text size="xs" c="dimmed">
            {t('New plans use this preference. Existing assignments keep their resources.')}
          </Text>
        </>
      </Stack>
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="form-actions">
        <Button
          onClick={() => void save()}
          loading={saving}
          disabled={
            !roleIdPattern.test(id) ||
            !title.trim() ||
            !description.trim() ||
            !instructions.trim() ||
            (preferenceMode !== 'auto' &&
              (!runtimeId || !resources.catalog || resources.loading || !eligibleForAnyOperation))
          }
        >
          {t('Save')} {initial ? t('version {p0}', { p0: initial.version + 1 }) : t('role')}
        </Button>
      </div>
    </div>
  );
}
