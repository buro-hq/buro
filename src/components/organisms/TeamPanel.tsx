import { roleLabels } from '../../ui/role-labels';
import { t } from '../../i18n/index.ts';
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

const profileRoles = new Set([
  'coordinator',
  'reviewer',
  'local_preview',
  'delivery_pr',
  'production_delivery',
]);

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
  const pool =
    resources.catalog?.selected?.workerPool ||
    (resources.catalog?.selected ? [resources.catalog.selected.worker] : []);
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Project team')}</h2>
          <p className="caption">
            {t('Role versions are saved in the project. Each task gets a separate session.')}
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
      <div className="team-grid">
        {roles.map((role) => {
          const color = roleColor(role.kind);
          const preference = role.runtimePreference;
          const hasSession =
            !!run && (role.id === 'coordinator' || run.agents.some((a) => a.name === role.id));
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
                <Badge variant="light" color="gray" size="xs">
                  v{role.version}
                </Badge>
              </div>
              <h3>{roleLabels(role).title}</h3>
              {run?.roleOrigins?.[role.id] && (
                <Badge size="xs" variant="light" color="sage">
                  {run.roleOrigins[role.id] === 'created'
                    ? t('Created for this goal')
                    : t('Reused')}
                </Badge>
              )}
              <span className="mono muted">{role.id}</span>
              <p>{roleLabels(role).description}</p>
              <Text size="xs" c="dimmed">
                {profileRoles.has(role.id)
                  ? t('Configured in execution profile')
                  : preference && preference.mode !== 'auto'
                    ? t(preference.mode === 'fixed' ? 'Only: {p0}' : 'Prefer: {p0}', {
                        p0:
                          pool.find((item) => item.id === preference.runtimeId)?.model ||
                          preference.runtimeId,
                      })
                    : t('Auto model')}
              </Text>
              <div className="role-actions">
                <button
                  className="text-button"
                  disabled={!hasSession}
                  onClick={() => onSession(role.id)}
                >
                  {hasSession ? t('Open session') : t('Not assigned yet')}
                  <ArrowUpRight size={12} />
                </button>
                <button
                  className="text-button"
                  disabled={!canEdit}
                  aria-label={t('Edit role {p0}', { p0: role.id })}
                  onClick={() => setEditor(role)}
                >
                  <Pencil size={13} />
                </button>
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
  const profileRole = profileRoles.has(id);
  const pool =
    resources.catalog?.selected?.workerPool ||
    (resources.catalog?.selected ? [resources.catalog.selected.worker] : []);
  const modelOptions = pool.map((runtime) => ({
    value: runtime.id,
    label: `${runtime.model || 'Codex'} · ${runtime.providerId || runtime.client}`,
  }));
  if (runtimeId && !modelOptions.some((item) => item.value === runtimeId))
    modelOptions.push({ value: runtimeId, label: runtimeId + ' · ' + t('Unavailable') });
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
          profileRole || preferenceMode === 'auto'
            ? { mode: 'auto' }
            : { mode: preferenceMode, runtimeId },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="goal-form role-form">
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
        {profileRole ? (
          <Text size="xs" c="dimmed">
            {t('Configured in execution profile')}
          </Text>
        ) : (
          <>
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
                searchable
                allowDeselect={false}
                disabled={!resources.catalog || resources.loading}
                nothingFoundMessage={t('No models in this project pool')}
                required
              />
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
        )}
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
            (!profileRole &&
              preferenceMode !== 'auto' &&
              (!runtimeId || !resources.catalog || resources.loading))
          }
        >
          {t('Save')} {initial ? t('version {p0}', { p0: initial.version + 1 }) : t('role')}
        </Button>
      </div>
    </div>
  );
}
