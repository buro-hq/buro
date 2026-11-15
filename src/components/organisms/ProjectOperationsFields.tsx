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
import type { ProjectProfile } from '../../../protocol/domain';
import type { DeliveryConfig } from '../../../protocol/operations';
import { PathInput } from '../molecules/PathInput';
import { useProject } from '../../data/provider';

export function ProjectOperationsFields({
  profile,
  root,
  projectId,
  onChange,
}: {
  profile: ProjectProfile;
  root?: string;
  projectId?: string;
  onChange: (patch: Partial<ProjectProfile>) => void;
}) {
  const { snapshot } = useProject();
  const components = profile.components || [];
  const delivery: DeliveryConfig = profile.delivery || {
    remote: 'origin',
    pullRequests: false,
    environments: [],
  };
  const updateDelivery = (patch: Partial<DeliveryConfig>) =>
    onChange({ delivery: { ...delivery, ...patch } });
  return (
    <>
      <TextInput
        label={t('Base branch')}
        description={t('New goals start here unless a parent run is selected.')}
        value={profile.baseBranch || ''}
        placeholder="main"
        onChange={(e) => onChange({ baseBranch: e.currentTarget.value })}
      />
      <div className="section-heading">
        <div>
          <h3>{t('Components and local preview')}</h3>
          <p className="caption">{t('Runs from the goal workspace. Migrations are excluded.')}</p>
        </div>
        <Button
          size="xs"
          variant="light"
          leftSection={<Plus size={13} />}
          disabled={components.length >= 12}
          onClick={() => {
            let n = components.length + 1;
            while (components.some((c) => c.id === 'component_' + n)) n++;
            onChange({
              components: [
                ...components,
                {
                  id: 'component_' + n,
                  name: t('Component ') + n,
                  kind: 'web',
                  path: './',
                  command: '',
                  port: 3000,
                  readyPath: '/',
                  instructions: '',
                  evidence: t('Added by user'),
                },
              ],
            });
          }}
        >
          {t('Add component')}
        </Button>
      </div>
      {components.map((component, index) => {
        const update = (patch: Partial<typeof component>) =>
          onChange({
            components: components.map((c, i) => (i === index ? { ...c, ...patch } : c)),
          });
        return (
          <div className="profile-check" key={component.id}>
            <div className="section-heading">
              <b>{component.name}</b>
              <ActionIcon
                aria-label={t('Remove component {p0}', { p0: component.id })}
                variant="subtle"
                color="gray"
                onClick={() => onChange({ components: components.filter((_, i) => i !== index) })}
              >
                <X size={14} />
              </ActionIcon>
            </div>
            <div className="profile-paths">
              <TextInput
                label={t('Component name')}
                value={component.name}
                onChange={(e) => update({ name: e.currentTarget.value })}
              />
              <Select
                label={t('Component type')}
                value={component.kind}
                allowDeselect={false}
                data={[
                  { value: 'web', label: t('Frontend') },
                  { value: 'api', label: 'HTTP API' },
                  { value: 'worker', label: t('Background worker') },
                  { value: 'cli', label: 'CLI' },
                  { value: 'library', label: t('Library') },
                  { value: 'other', label: t('Other') },
                ]}
                onChange={(v) => update({ kind: v as typeof component.kind })}
              />
            </div>
            <PathInput
              root={root}
              projectId={projectId}
              label={t('Working directory')}
              value={component.path}
              onChange={(path) => update({ path })}
            />
            <TextInput
              label={t('Local launch command')}
              description={t(
                'For HTTP, use PORT or {port}: the service allocates a free port. API addresses are available as PROJECT_COMPONENT_API_URL (from the component ID). Leave empty for checks without a server.',
              )}
              value={component.command}
              onChange={(e) => update({ command: e.currentTarget.value })}
            />
            <div className="profile-paths">
              <NumberInput
                label={t('HTTP port: 0 — no HTTP')}
                min={0}
                max={65535}
                value={component.port}
                onChange={(v) => update({ port: Number(v) })}
              />
              <TextInput
                label={t('Readiness path')}
                description={t('HTTP readiness is checked for up to 60 seconds after launch.')}
                placeholder="/health"
                value={component.readyPath}
                onChange={(e) => update({ readyPath: e.currentTarget.value })}
              />
            </div>
            <Textarea
              label={t('How to verify the result and startup dependencies')}
              value={component.instructions}
              onChange={(e) => update({ instructions: e.currentTarget.value })}
            />
            <p className="caption">{component.evidence}</p>
            <p className="caption">
              {t(
                'Preview reads .env and .env.local from the source project and component directory. Overrides: .buro/local/environment.env → .buro/local/',
              )}
              {component.id}
              {t('.env. Values are not copied into the shared profile.')}
            </p>
          </div>
        );
      })}
      {!components.length && (
        <p className="caption">
          {t('Research will suggest components. You can also add them manually.')}
        </p>
      )}
      <div className="section-heading">
        <div>
          <h3>{t('Pull requests and delivery')}</h3>
          <p className="caption">
            {t('Implementation readiness is tracked separately from delivery.')}
          </p>
        </div>
      </div>
      <Checkbox
        label={t('Allow draft PR creation')}
        description={t(
          'For PR outcomes, the service pushes a separate branch and opens a draft PR. GitHub via gh is currently supported.',
        )}
        checked={delivery.pullRequests}
        onChange={(e) => updateDelivery({ pullRequests: e.currentTarget.checked })}
      />
      <TextInput
        label="Git remote"
        value={delivery.remote}
        onChange={(e) => updateDelivery({ remote: e.currentTarget.value })}
      />
      {delivery.environments.map((environment, index) => {
        const update = (patch: Partial<typeof environment>) =>
          updateDelivery({
            environments: delivery.environments.map((e, i) =>
              i === index ? { ...e, ...patch } : e,
            ),
          });
        return (
          <div className="profile-check" key={environment.id}>
            <div className="section-heading">
              <b>{environment.name}</b>
              <ActionIcon
                aria-label={t('Remove environment {p0}', { p0: environment.id })}
                variant="subtle"
                color="gray"
                onClick={() =>
                  updateDelivery({
                    environments: delivery.environments.filter((_, i) => i !== index),
                  })
                }
              >
                <X size={14} />
              </ActionIcon>
            </div>
            <Checkbox
              label={t('Allow delivery to this environment')}
              checked={environment.enabled}
              onChange={(e) => update({ enabled: e.currentTarget.checked })}
            />
            <TextInput
              label={t('Environment name')}
              value={environment.name}
              onChange={(e) => update({ name: e.currentTarget.value })}
            />
            <Select
              label={t('Delivery role')}
              value={environment.roleId}
              allowDeselect={false}
              data={(snapshot?.roles || []).map((r) => ({ value: r.id, label: r.title }))}
              onChange={(v) => update({ roleId: v || 'production_delivery' })}
            />
            <Textarea
              label={t('Delivery command')}
              description={t(
                'Runs from the accepted workspace with a 15-minute command limit. The commit is available as PROJECT_DELIVERY_COMMIT. Do not include migrations.',
              )}
              value={environment.command}
              onChange={(e) => update({ command: e.currentTarget.value })}
            />
            <TextInput
              label={t('Post-delivery verification URL')}
              placeholder="https://…/health"
              value={environment.url}
              onChange={(e) => update({ url: e.currentTarget.value })}
            />
            <Checkbox
              label={t('Confirm before delivery')}
              checked={environment.requireConfirmation}
              onChange={(e) => update({ requireConfirmation: e.currentTarget.checked })}
            />
            <p className="caption">
              {t('Credentials and local variables: .buro/local/')}
              {environment.id}
              {t('.env. Values are excluded from the shared profile.')}
            </p>
          </div>
        );
      })}
      <Button
        size="xs"
        variant="light"
        leftSection={<Plus size={13} />}
        disabled={delivery.environments.length >= 8}
        onClick={() => {
          const id = delivery.environments.length
            ? 'environment_' + crypto.randomUUID().slice(0, 8)
            : 'production';
          updateDelivery({
            environments: [
              ...delivery.environments,
              {
                id,
                name: delivery.environments.length ? t('New environment') : 'Production',
                enabled: false,
                command: '',
                url: '',
                requireConfirmation: true,
                roleId: 'production_delivery',
              },
            ],
          });
        }}
      >
        {t('Add environment')}
      </Button>
      <p className="caption">
        {t(
          'Shared settings: .buro/project.json. Machine-specific settings and credentials: .buro/local/. Environment delivery is disabled by default.',
        )}
      </p>
    </>
  );
}
