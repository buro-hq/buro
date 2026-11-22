import { t } from '../../i18n/index.ts';
import {
  ActionIcon,
  Button,
  Checkbox,
  NumberInput,
  Select,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { PathListInput } from '../molecules/PathInput';
import { ContextMaterialsEditor } from './ContextMaterialsEditor';
import { ProjectOperationsFields } from './ProjectOperationsFields';
import type { ProjectProfile } from '../../../protocol/domain.ts';
import { ProjectResourceField } from './ExecutionResources';
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
    [paths, setPaths] = useState(initial.scope.plannedPaths.join('\n')),
    [protectedPaths, setProtectedPaths] = useState(initial.scope.protectedPaths.join('\n')),
    [setup, setSetup] = useState(initial.setup.map((c) => c.command).join('\n')),
    [checkOutputs, setCheckOutputs] = useState<Record<string, string>>(
      Object.fromEntries(
        initial.checks.map((check) => [check.id, (check.outputPaths || []).join('\n')]),
      ),
    ),
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
        scope: {
          mode: profile.scope.mode,
          plannedPaths: list(paths),
          protectedPaths: list(protectedPaths),
        },
        checks: profile.checks.map((check) => ({
          ...check,
          outputPaths: list(checkOutputs[check.id] ?? (check.outputPaths || []).join('\n')),
        })),
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
      <ProjectResourceField
        value={profile.resourceProfile}
        onChange={(resourceProfile) => update({ resourceProfile })}
      />
      <ContextMaterialsEditor projectId={projectId} root={root} scope="project" />
      <div className="profile-paths">
        <PathListInput
          root={root}
          projectId={projectId}
          label={t('Planned paths')}
          description={t(
            'Optional guidance for the team. Leave empty for automatic discovery. One path per line; ./ means the entire project.',
          )}
          value={paths}
          onChange={setPaths}
        />
        <PathListInput
          root={root}
          projectId={projectId}
          label={t('Protected paths')}
          description={t(
            'Always blocked in both modes. Service metadata and dependencies are protected automatically.',
          )}
          value={protectedPaths}
          onChange={setProtectedPaths}
        />
      </div>
      <Checkbox
        label={t('Forbid changes outside planned paths')}
        description={t(
          'Requires selected paths and a compatible execution backend. Agent commands and intermediate checks are deferred; final isolated checks and an independent review still run.',
        )}
        checked={profile.scope.mode === 'strict'}
        onChange={(event) =>
          update({
            scope: { ...profile.scope, mode: event.currentTarget.checked ? 'strict' : 'advisory' },
          })
        }
      />
      {profile.scope.mode === 'strict' && !list(paths).length && (
        <p className="caption" role="status">
          {t('Choose at least one planned path to enable this restriction.')}
        </p>
      )}
      <p className="caption">
        {t('Check definitions and protected package.json fields remain protected in both modes.')}
      </p>
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
          <details>
            <summary>{t('Writable check outputs')}</summary>
            <Textarea
              label={t('Output directories')}
              description={t(
                'Build and cache outputs only. Checked source files remain read-only. One directory per line.',
              )}
              placeholder="dist/"
              autosize
              minRows={1}
              maxRows={4}
              value={checkOutputs[check.id] ?? (check.outputPaths || []).join('\n')}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setCheckOutputs((current) => ({ ...current, [check.id]: value }));
              }}
            />
          </details>
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
      <NumberInput
        label={t('Maximum team size')}
        value={profile.maxWorkers}
        onChange={(v) => update({ maxWorkers: Number(v) })}
        min={1}
        max={Number.MAX_SAFE_INTEGER}
        allowDecimal={false}
        allowNegative={false}
      />
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
        </p>
      )}
      <Button
        loading={saving}
        disabled={
          (profile.scope.mode === 'strict' && !list(paths).length) ||
          profile.checks.some((c) => !c.command.trim() || !c.title.trim())
        }
        onClick={() => void save()}
      >
        {submitLabel}
      </Button>
    </div>
  );
}
