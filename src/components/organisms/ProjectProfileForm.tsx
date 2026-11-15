import { t } from '../../i18n/index.ts';
import { ActionIcon, Button, Checkbox, Select, Textarea, TextInput } from '@mantine/core';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { PathListInput } from '../molecules/PathInput';
import { ContextMaterialsEditor } from './ContextMaterialsEditor';
import { ProjectOperationsFields } from './ProjectOperationsFields';
import type { ProjectProfile } from '../../../protocol/domain.ts';
export function ProjectProfileForm({
  initial,
  projectId,
  root,
  onSave,
  submitLabel,
}: {
  initial: ProjectProfile;
  projectId?: string;
  root?: string;
  onSave: (profile: ProjectProfile) => Promise<void>;
  submitLabel: string;
}) {
  const [profile, setProfile] = useState(initial),
    [paths, setPaths] = useState(initial.allowedPaths.join('\n')),
    [protectedPaths, setProtectedPaths] = useState(initial.protectedPaths.join('\n')),
    [setup, setSetup] = useState(initial.setup.map((c) => c.command).join('\n')),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const update = (patch: Partial<ProjectProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const list = (text: string) =>
    text
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...profile,
        allowedPaths: list(paths),
        protectedPaths: list(protectedPaths),
        setup: setup
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((command, i) => ({
            id: 'setup_' + i,
            title: t('Setup ') + (i + 1),
            command,
            timeoutMs: 300000,
          })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="profile-form">
      <ProjectOperationsFields
        root={root}
        projectId={projectId}
        profile={profile}
        onChange={update}
      />
      <Textarea
        label={t('Project context')}
        description={t('What agents should know before starting work')}
        value={profile.context}
        onChange={(e) => update({ context: e.currentTarget.value })}
        minRows={3}
      />
      <ContextMaterialsEditor projectId={projectId} root={root} scope="project" />
      <div className="profile-paths">
        <PathListInput
          root={root}
          projectId={projectId}
          label={t('Allowed paths')}
          description={t('One per line. ./ means the entire project')}
          value={paths}
          onChange={setPaths}
        />
        <PathListInput
          root={root}
          projectId={projectId}
          label={t('Protected paths')}
          description={t('.git and .buro are always protected')}
          value={protectedPaths}
          onChange={setProtectedPaths}
        />
      </div>
      <div className="section-heading">
        <h3>{t('Result checks')}</h3>
        <Button
          size="xs"
          variant="subtle"
          disabled={profile.checks.length >= 8}
          leftSection={<Plus size={13} />}
          onClick={() => {
            let n = profile.checks.length + 1;
            while (profile.checks.some((c) => c.id === 'check_' + n)) n++;
            update({
              checks: [
                ...profile.checks,
                { id: 'check_' + n, title: t('Check ') + n, command: '', timeoutMs: 180000 },
              ],
            });
          }}
        >
          {t('Add check')}
        </Button>
      </div>
      {!profile.checks.length && (
        <p className="caption">{t('Add a check before starting goals.')}</p>
      )}
      {profile.checks.map((check, i) => (
        <div className="profile-check" key={check.id}>
          <TextInput
            label={t('Check name')}
            value={check.title}
            onChange={(e) =>
              update({
                checks: profile.checks.map((c, j) =>
                  j === i ? { ...c, title: e.currentTarget.value } : c,
                ),
              })
            }
          />
          <TextInput
            label={t('Check command')}
            placeholder="yarn test"
            value={check.command}
            onChange={(e) => {
              const command = e.currentTarget.value;
              update({ checks: profile.checks.map((c, j) => (j === i ? { ...c, command } : c)) });
            }}
          />
          <div className="profile-check-options">
            <Checkbox
              size="xs"
              label={t('Selected by default')}
              checked={profile.defaultCheckIds.includes(check.id)}
              onChange={(e) =>
                update({
                  defaultCheckIds: e.currentTarget.checked
                    ? [...profile.defaultCheckIds, check.id]
                    : profile.defaultCheckIds.filter((id) => id !== check.id),
                })
              }
            />
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t('Remove check {p0}', { p0: check.title })}
              onClick={() =>
                update({
                  checks: profile.checks.filter((c) => c.id !== check.id),
                  defaultCheckIds: profile.defaultCheckIds.filter((id) => id !== check.id),
                })
              }
            >
              <X size={14} />
            </ActionIcon>
          </div>
        </div>
      ))}
      <Select
        label={t('Execution environment')}
        value={profile.environment?.provider || 'native'}
        allowDeselect={false}
        data={[
          { value: 'native', label: t('Native sandbox') },
          { value: 'docker', label: t('Docker container') },
        ]}
        onChange={(value) =>
          update({
            environment: { ...profile.environment, provider: value as 'native' | 'docker' },
          })
        }
      />
      {profile.environment?.provider === 'docker' && (
        <TextInput
          label={t('Agent image')}
          value={profile.environment.image || ''}
          onChange={(event) =>
            update({ environment: { ...profile.environment!, image: event.currentTarget.value } })
          }
        />
      )}
      <Select
        label={t('Concurrent checks')}
        description={t(
          'Use parallel checks only when their commands do not share writable outputs.',
        )}
        value={String(profile.checkConcurrency || 1)}
        allowDeselect={false}
        data={['1', '2', '4']}
        onChange={(value) => update({ checkConcurrency: Number(value) })}
      />
      <Textarea
        label={t('Environment setup')}
        description={t(
          'Optional. One command per line, for example npm ci. Runs in the workspace before checks and goal execution.',
        )}
        value={setup}
        onChange={(e) => setSetup(e.currentTarget.value)}
        minRows={2}
      />
      <div className="profile-paths">
        <Select
          label={t('Concurrent workers')}
          value={String(profile.maxWorkers)}
          onChange={(v) => update({ maxWorkers: Number(v) })}
          data={['1', '2']}
          allowDeselect={false}
        />
        <Select
          label={t('Repair attempts')}
          value={String(profile.maxRepairs)}
          onChange={(v) => update({ maxRepairs: Number(v) })}
          data={['0', '1', '2']}
          allowDeselect={false}
        />
      </div>
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
        </p>
      )}
      <Button
        loading={saving}
        disabled={!paths.trim() || profile.checks.some((c) => !c.command.trim() || !c.title.trim())}
        onClick={() => void save()}
      >
        {submitLabel}
      </Button>
    </div>
  );
}
