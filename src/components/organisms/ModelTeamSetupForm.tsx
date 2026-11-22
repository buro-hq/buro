import { useState } from 'react';
import {
  Accordion,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  ResourceSetupInputSchema,
  type ResourceCatalog,
  type ResourceSetupInput,
  type ModelRuntimeTemplate,
} from '../../../protocol/resources.ts';
import { ManagedLimitsSchema } from '../../../protocol/resource-builtins.ts';
import { t } from '../../i18n/index.ts';

function uniqueId(seed: string, used: string[]) {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const prefix = /^[a-z]/.test(base) ? base : 'model-' + base;
  let id = prefix || 'model';
  for (let n = 2; used.includes(id); n++) id = prefix + '-' + n;
  return id;
}
type Props = {
  catalog: ResourceCatalog;
  connectionId?: string;
  model?: string;
  templates?: ModelRuntimeTemplate[];
  saving: boolean;
  onClose: () => void;
  onSave: (setup: ResourceSetupInput) => Promise<void>;
};
/** Model templates are server-authored; generic backends use their installed parser. */
export function ModelTeamSetupForm({
  catalog,
  connectionId,
  model,
  templates,
  saving,
  onClose,
  onSave,
}: Props) {
  const available = templates
    ? catalog.backends.filter((backend) =>
        templates.some((template) => template.backend === backend.id),
      )
    : catalog.backends;
  const [backend, setBackend] = useState(available[0]?.id || '');
  const descriptor = available.find((item) => item.id === backend);
  const template = templates?.find((item) => item.backend === backend);
  const definitions = catalog.configured?.runtimes.map((item) => item.definition) || [];
  const existing =
    model && connectionId
      ? catalog.runtimes.find(
          (item) =>
            item.backendId === backend && item.providerId === connectionId && item.model === model,
        )
      : undefined;
  const initialConfig =
    definitions.find((item) => item.id === existing?.id)?.config ||
    template?.config ||
    descriptor?.defaultConfig ||
    {};
  const [raw, setRaw] = useState(JSON.stringify(initialConfig, null, 2));
  const [runtimeId, setRuntimeId] = useState(
    existing?.id ||
      uniqueId(
        connectionId && model ? connectionId + '-' + model : backend + '-instance',
        definitions.map((item) => item.id),
      ),
  );
  const candidateId = existing?.id || runtimeId;
  const current = catalog.profiles.find((item) => item.id === catalog.defaultProfile);
  const [profileId, setProfileId] = useState(
    uniqueId(
      runtimeId + '-team',
      catalog.configured?.profiles.map((item) => item.profile.id) ||
        catalog.profiles.map((item) => item.id),
    ),
  );
  const [name, setName] = useState(
    (model || descriptor?.label || t('Execution backend')) + ' · ' + t('Team'),
  );
  const [coordinator, setCoordinator] = useState(current?.coordinator || candidateId);
  const [worker, setWorker] = useState(candidateId);
  const [reviewer, setReviewer] = useState(current?.reviewer || candidateId);
  const [workerPool, setWorkerPool] = useState([
    ...new Set([...(current?.workerPool || (current ? [current.worker] : [])), candidateId]),
  ]);
  const [policy, setPolicy] = useState<'local-only' | 'hybrid'>(current?.policy || 'hybrid');
  const savedLimits =
    typeof initialConfig.limits === 'object' &&
    initialConfig.limits !== null &&
    !Array.isArray(initialConfig.limits)
      ? initialConfig.limits
      : {};
  const defaults = ManagedLimitsSchema.parse(descriptor?.editor === 'managed' ? savedLimits : {});
  const [contextTokens, setContextTokens] = useState<string | number>(defaults.contextTokens);
  const [maxOutputTokens, setMaxOutputTokens] = useState<string | number>(defaults.maxOutputTokens);
  const [error, setError] = useState('');
  const polished = descriptor?.editor === 'managed' && !!template;
  const choices = catalog.runtimes.map((item) => ({
    value: item.id,
    label: [
      item.model ||
        catalog.backends.find((backend) => backend.id === item.backendId)?.label ||
        item.backendId,
      item.id,
    ].join(' · '),
  }));
  if (!existing)
    choices.push({
      value: candidateId,
      label: `${model || descriptor?.label || backend} · ${t('New model')}`,
    });
  function changeCandidate(nextId: string) {
    const previous = candidateId;
    setRuntimeId(nextId);
    setCoordinator((value) => (value === previous ? nextId : value));
    setWorker((value) => (value === previous ? nextId : value));
    setReviewer((value) => (value === previous ? nextId : value));
    setWorkerPool((pool) => [...new Set(pool.map((id) => (id === previous ? nextId : id)))]);
  }
  async function save() {
    setError('');
    try {
      const config = JSON.parse(raw);
      const parsed = ResourceSetupInputSchema.parse({
        expectedRevision: catalog.configurationRevision,
        runtimes: existing
          ? []
          : [
              {
                id: candidateId,
                backend,
                config: polished
                  ? { ...config, limits: { ...defaults, contextTokens, maxOutputTokens } }
                  : config,
              },
            ],
        profile: { id: profileId, name, policy, coordinator, worker, reviewer, workerPool },
      });
      await onSave(parsed);
    } catch (error) {
      setError(
        error instanceof Error && 'code' in error && error.code === 'RESOURCE_SETUP_CONFLICT'
          ? t(
              'Resource settings changed elsewhere. Cancel, refresh, then create the profile again.',
            )
          : error instanceof SyntaxError
            ? t('Enter a valid JSON object.')
            : error instanceof Error
              ? error.message
              : String(error),
      );
    }
  }
  return (
    <Modal
      opened
      onClose={onClose}
      title={model ? t('Use model in a team') : t('Add execution backend')}
      centered
      size="lg"
      closeOnClickOutside={!saving}
      closeOnEscape={!saving}
      withCloseButton={!saving}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <div>
              <Text fw={600}>{model || t('Execution backend')}</Text>
              <Text size="xs" c="dimmed">
                {connectionId}
              </Text>
            </div>
            <Badge variant="light">
              {existing ? t('Existing model configuration') : t('New model configuration')}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {t(
              'Create a separate team profile. Your current default and existing runs stay unchanged.',
            )}
          </Text>
          <Select
            label={t('Backend implementation')}
            value={backend}
            data={available.map((item) => ({ value: item.id, label: item.label }))}
            allowDeselect={false}
            disabled={saving}
            onChange={(value) => {
              if (!value) return;
              const nextTemplate = templates?.find((item) => item.backend === value);
              const nextConfig =
                nextTemplate?.config ||
                available.find((item) => item.id === value)?.defaultConfig ||
                {};
              setBackend(value);
              setRaw(JSON.stringify(nextConfig, null, 2));
              if (available.find((item) => item.id === value)?.editor === 'managed') {
                const limits = ManagedLimitsSchema.parse(nextConfig.limits || {});
                setContextTokens(limits.contextTokens);
                setMaxOutputTokens(limits.maxOutputTokens);
              }
              changeCandidate(
                uniqueId(
                  value + '-instance',
                  definitions.map((item) => item.id),
                ),
              );
            }}
          />
          {!existing && (
            <TextInput
              label={t('Runtime ID')}
              value={runtimeId}
              onChange={(event) => changeCandidate(event.currentTarget.value)}
              required
              maxLength={64}
              disabled={saving}
            />
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('Profile ID')}
              value={profileId}
              onChange={(event) => setProfileId(event.currentTarget.value)}
              required
              maxLength={64}
              disabled={saving}
            />
            <TextInput
              label={t('Profile name')}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={100}
              disabled={saving}
            />
          </SimpleGrid>
          <Select
            label={t('Data policy')}
            data={[
              { value: 'local-only', label: t('Local only') },
              { value: 'hybrid', label: t('Hybrid') },
            ]}
            value={policy}
            onChange={(value) => setPolicy(value === 'local-only' ? 'local-only' : 'hybrid')}
            allowDeselect={false}
            disabled={saving}
          />
          <Text size="xs" c="dimmed">
            {t('The service validates configuration and data locality before saving.')}
            {template
              ? ' ' +
                (template.local
                  ? t('Trusted local model endpoint.')
                  : t('Requests leave your trusted local environment.'))
              : ''}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            {[
              [t('Coordinator model'), coordinator, setCoordinator],
              [
                t('Primary worker model'),
                worker,
                (value: string) => {
                  setWorker(value);
                  setWorkerPool((pool) => [...new Set([...pool, value])]);
                },
              ],
              [t('Reviewer model'), reviewer, setReviewer],
            ].map(([label, value, setter]) => (
              <Select
                key={label as string}
                label={label as string}
                data={choices}
                value={value as string}
                onChange={(value) => {
                  if (value) (setter as (value: string) => void)(value);
                }}
                allowDeselect={false}
                searchable
                disabled={saving}
              />
            ))}
          </SimpleGrid>
          <MultiSelect
            label={t('Allowed worker models')}
            description={t(
              'The coordinator may choose only these models. The primary worker is always included.',
            )}
            data={choices}
            value={workerPool}
            onChange={(values) => setWorkerPool([...new Set([worker, ...values])])}
            searchable
            disabled={saving}
            maxValues={16}
          />
          {!existing &&
            (polished ? (
              <Accordion variant="contained" transitionDuration={0}>
                <Accordion.Item value="limits">
                  <Accordion.Control>{t('Advanced model limits')}</Accordion.Control>
                  <Accordion.Panel>
                    <SimpleGrid cols={2}>
                      <NumberInput
                        label={t('Context tokens')}
                        value={contextTokens}
                        onChange={setContextTokens}
                        min={1024}
                        max={262144}
                        allowDecimal={false}
                        disabled={saving}
                      />
                      <NumberInput
                        label={t('Output tokens per request')}
                        value={maxOutputTokens}
                        onChange={setMaxOutputTokens}
                        min={128}
                        max={32768}
                        allowDecimal={false}
                        disabled={saving}
                      />
                    </SimpleGrid>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            ) : (
              <Textarea
                label={t('Backend configuration (JSON)')}
                description={t('Configuration is validated by the installed backend.')}
                value={raw}
                onChange={(event) => setRaw(event.currentTarget.value)}
                minRows={6}
                maxRows={15}
                autosize
                maxLength={64000}
                disabled={saving}
                spellCheck={false}
                styles={{ input: { fontFamily: 'monospace' } }}
              />
            ))}
          <Text size="xs" c="dimmed">
            {t(
              'Save now, restart the Buro service, then explicitly select this profile. Saving does not run a model or diagnostic.',
            )}
          </Text>
          {error && (
            <Text role="alert" c="red" size="sm">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={saving} mih={44}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={saving} disabled={!descriptor} mih={44}>
              {t('Save team profile')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
