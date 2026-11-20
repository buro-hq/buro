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
} from '@mantine/core';
import {
  ManagedLimitsSchema,
  ResourceSetupInputSchema,
  type ResourceCatalog,
  type ResourceSetupInput,
} from '../../../protocol/resources.ts';
import { endpointIsLocal, modelEndpointURL } from '../../../protocol/endpoint-trust.ts';
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
  connectionId: string;
  model: string;
  saving: boolean;
  onClose: () => void;
  onSave: (setup: ResourceSetupInput) => Promise<void>;
};
export function ModelTeamSetupForm({
  catalog,
  connectionId,
  model,
  saving,
  onClose,
  onSave,
}: Props) {
  const connection = catalog.connections.find((item) => item.id === connectionId)!;
  const current = catalog.profiles.find((item) => item.id === catalog.defaultProfile)!;
  const definitions = catalog.configured?.runtimes.map((item) => item.definition) || [];
  const existing = catalog.runtimes.find(
    (item) => item.client === 'managed' && item.providerId === connectionId && item.model === model,
  );
  const [runtimeId] = useState(
    existing?.id ||
      uniqueId(
        connectionId + '-' + model,
        definitions.map((item) => item.id),
      ),
  );
  const [profileId, setProfileId] = useState(() =>
    uniqueId(
      runtimeId + '-team',
      catalog.configured?.profiles.map((item) => item.profile.id) ||
        catalog.profiles.map((item) => item.id),
    ),
  );
  const [name, setName] = useState(model + ' · ' + t('Team'));
  const [coordinator, setCoordinator] = useState(current.coordinator);
  const [worker, setWorker] = useState(runtimeId);
  const [reviewer, setReviewer] = useState(current.reviewer);
  const [workerPool, setWorkerPool] = useState([
    ...new Set([...(current.workerPool || [current.worker]), runtimeId]),
  ]);
  const [policy, setPolicy] = useState(current.policy);
  const matching = definitions.find(
    (item) =>
      item.client === 'managed' && item.connectionId === connectionId && item.model === model,
  );
  const defaults =
    matching?.client === 'managed'
      ? matching.limits
      : ManagedLimitsSchema.parse(
          connection.kind === 'ollama' ? { contextTokens: 16384, maxOutputTokens: 2048 } : {},
        );
  const [contextTokens, setContextTokens] = useState<string | number>(defaults.contextTokens);
  const [maxOutputTokens, setMaxOutputTokens] = useState<string | number>(defaults.maxOutputTokens);
  const [error, setError] = useState('');
  const local =
    connection.kind === 'ollama' &&
    endpointIsLocal(modelEndpointURL(connection.endpoint), connection.trust) &&
    !/(?:[:_-]cloud)(?:$|:)/i.test(model);
  const choices = catalog.runtimes.map((item) => ({
    value: item.id,
    label: item.client === 'codex' ? 'Codex' : `${item.model} · ${item.providerId} · ${item.id}`,
    local: item.local,
  }));
  if (!existing)
    choices.push({
      value: runtimeId,
      label: `${model} · ${connectionId} · ${t('New model')}`,
      local,
    });
  const options = choices.map(({ value, label }) => ({ value, label }));
  async function save() {
    setError('');
    if ((catalog.configured?.profiles || []).some((item) => item.profile.id === profileId)) {
      setError(t('This profile ID already exists. Choose another ID.'));
      return;
    }
    const selected = [coordinator, worker, reviewer, ...workerPool];
    if (
      policy === 'local-only' &&
      selected.some((id) => !choices.find((item) => item.value === id)?.local)
    ) {
      setError(
        t(
          'Local-only teams cannot include external or native runtimes. Choose local models or explicitly select Hybrid.',
        ),
      );
      return;
    }
    const parsed = ResourceSetupInputSchema.safeParse({
      expectedRevision: catalog.configurationRevision,
      runtimes: existing
        ? []
        : [
            {
              id: runtimeId,
              client: 'managed',
              connectionId,
              model,
              limits: { ...defaults, contextTokens, maxOutputTokens },
            },
          ],
      profile: { id: profileId, name, policy, coordinator, worker, reviewer, workerPool },
    });
    if (!parsed.success) {
      setError(t('Check the profile ID, name, selected models and context/output limits.'));
      return;
    }
    try {
      await onSave(parsed.data);
    } catch (error) {
      setError(
        error instanceof Error && 'code' in error && error.code === 'RESOURCE_SETUP_CONFLICT'
          ? t(
              'Resource settings changed elsewhere. Cancel, refresh, then create the profile again.',
            )
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
      title={t('Use model in a team')}
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
              <Text fw={600}>{model}</Text>
              <Text size="xs" c="dimmed">
                {connectionId} · {connection.endpoint}
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
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('Profile ID')}
              value={profileId}
              onChange={(event) => setProfileId(event.currentTarget.value)}
              required
              maxLength={64}
              disabled={saving}
              styles={{ input: { minHeight: 44 } }}
            />
            <TextInput
              label={t('Profile name')}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={100}
              disabled={saving}
              styles={{ input: { minHeight: 44 } }}
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
            styles={{ input: { minHeight: 44 } }}
          />
          <Text size="xs" c="dimmed">
            {policy === 'hybrid'
              ? t(
                  'Hybrid can use the selected external providers for project context. Review every role and the worker pool before saving.',
                )
              : t('All roles and alternative workers must use trusted local model endpoints.')}
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
                data={options}
                value={value as string}
                onChange={(value) => {
                  if (value) (setter as (value: string) => void)(value);
                }}
                allowDeselect={false}
                searchable
                disabled={saving}
                styles={{ input: { minHeight: 44 } }}
              />
            ))}
          </SimpleGrid>
          <MultiSelect
            label={t('Allowed worker models')}
            description={t(
              'The coordinator may choose only these models. The primary worker is always included.',
            )}
            data={options}
            value={workerPool}
            onChange={(values) => setWorkerPool([...new Set([worker, ...values])])}
            searchable
            disabled={saving}
            maxValues={16}
            styles={{ input: { minHeight: 44 } }}
          />
          {!existing && (
            <Accordion variant="contained" transitionDuration={0}>
              <Accordion.Item value="limits">
                <Accordion.Control>{t('Advanced model limits')}</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="sm">
                    <Text size="xs" c="dimmed">
                      {t('Runtime ID')}: {runtimeId}
                    </Text>
                    <SimpleGrid cols={2}>
                      <NumberInput
                        label={t('Context tokens')}
                        value={contextTokens}
                        onChange={setContextTokens}
                        min={1024}
                        max={262144}
                        allowDecimal={false}
                        disabled={saving}
                        styles={{ input: { minHeight: 44 } }}
                      />
                      <NumberInput
                        label={t('Output tokens per request')}
                        value={maxOutputTokens}
                        onChange={setMaxOutputTokens}
                        min={128}
                        max={32768}
                        allowDecimal={false}
                        disabled={saving}
                        styles={{ input: { minHeight: 44 } }}
                      />
                    </SimpleGrid>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          )}
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
            <Button type="submit" loading={saving} mih={44}>
              {t('Save team profile')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
