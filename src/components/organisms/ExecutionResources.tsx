import { useState } from 'react';
import { Accordion, Badge, Button, Group, Paper, Select, Stack, Text } from '@mantine/core';
import type {
  ResourceCatalog,
  ResourceConnection,
  ResourceSetupInput,
  ResourceModel,
  ModelRuntimeTemplate,
} from '../../../protocol/resources.ts';
import { useResourceCatalog } from '../../features/resources/useResourceCatalog';
import { t } from '../../i18n/index.ts';
import { ApiConnectionForm } from './ApiConnectionForm';
import { ModelTeamSetupForm } from './ModelTeamSetupForm';

export function ExecutionResources() {
  const { client, supported, canConfigure, canSetup, catalog, error, loading, refresh } =
    useResourceCatalog();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [models, setModels] = useState<
    Record<string, { revision: string; models: ResourceModel[] }>
  >({});
  const [editing, setEditing] = useState<ResourceCatalog['connections'][number] | 'new' | null>(
    null,
  );
  const [saved, setSaved] = useState(false);
  const [catalogStale, setCatalogStale] = useState(false);
  const [setup, setSetup] = useState<{
    catalog: ResourceCatalog;
    connectionId?: string;
    model?: string;
    templates?: ModelRuntimeTemplate[];
  } | null>(null);
  const [setupSaved, setSetupSaved] = useState<string | null>(null);
  if (!supported) return null;
  const profile = catalog?.profiles.find((item) => item.id === catalog.defaultProfile);
  const selected = new Set(profile ? [profile.coordinator, profile.worker, profile.reviewer] : []);
  const editedConnection = typeof editing === 'object' ? editing || undefined : undefined;
  async function reload() {
    const result = await refresh();
    if (result) setCatalogStale(false);
    return result;
  }
  async function saveConnection(connection: ResourceConnection) {
    setBusy('save-connection');
    setActionError('');
    try {
      await client!.command({
        method: 'resources.connection.save',
        params: { connection, expectedRevision: editedConnection?.revision || null },
      });
      setModels((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      setSaved(true);
      setCatalogStale(!(await reload()));
      setEditing(null);
    } finally {
      setBusy('');
    }
  }
  async function useProfile(profileId: string) {
    setBusy('profile');
    setActionError('');
    try {
      await client!.command({ method: 'resources.use', params: { profileId } });
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }
  async function saveSetup(input: ResourceSetupInput) {
    setBusy('setup');
    try {
      await client!.command({ method: 'resources.setup.save', params: input });
      setSetupSaved(input.profile.id);
      setCatalogStale(!(await reload()));
      setSetup(null);
    } finally {
      setBusy('');
    }
  }
  async function check(runtimeId: string) {
    setBusy(runtimeId);
    setActionError('');
    try {
      await client!.command({ method: 'resources.probe', params: { runtimeId } });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      await reload();
      setBusy('');
    }
  }
  async function discover(connectionId: string) {
    const revision = catalog?.connections.find(
      (connection) => connection.id === connectionId,
    )?.revision;
    if (!revision) return;
    setBusy(connectionId);
    setActionError('');
    try {
      const result = await client!.command<ResourceModel[]>({
        method: 'resources.models',
        params: { connectionId },
      });
      setModels((current) => ({
        ...current,
        [connectionId]: { revision, models: result },
      }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="appearance-section">
      <Group justify="space-between" mb="xs">
        <h3>{t('Execution resources')}</h3>
        <Button variant="subtle" size="xs" mih={44} onClick={() => void reload()} loading={loading}>
          {t('Refresh')}
        </Button>
      </Group>
      <Stack gap="sm">
        <Select
          label={t('Default execution profile')}
          value={catalog?.defaultProfile || null}
          data={
            catalog?.profiles.map((profile) => ({ value: profile.id, label: profile.name })) || []
          }
          allowDeselect={false}
          disabled={!catalog || !!busy}
          onChange={(value) => {
            if (value && value !== catalog?.defaultProfile) void useProfile(value);
          }}
          description={t('New runs inherit this profile. Existing sessions keep their resources.')}
        />
        {profile && (
          <Group gap="xs" align="center">
            <Badge variant="light">
              {profile.policy === 'local-only' ? t('Local only') : t('Hybrid')}
            </Badge>
            {(
              [
                ['Coordinator', profile.coordinator],
                ['Workers', profile.worker],
                ['Reviewer', profile.reviewer],
              ] as const
            ).map(([label, id]) => {
              const resource = catalog!.runtimes.find((item) => item.id === id);
              return (
                <Text key={label} size="xs" c="dimmed">
                  {t(label)}: {resource?.model || id}
                </Text>
              );
            })}
          </Group>
        )}
        <Accordion variant="contained" transitionDuration={0}>
          <Accordion.Item value="connections">
            <Accordion.Control>{t('Models and connections')}</Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                {canConfigure && (
                  <Group justify="space-between" gap="sm">
                    <Text size="xs" c="dimmed" style={{ flex: '1 1 200px' }}>
                      {t('Configure an installed model provider or execution backend.')}
                    </Text>
                    <Button
                      variant="light"
                      size="xs"
                      mih={44}
                      disabled={!!busy || !catalog}
                      onClick={() => setEditing('new')}
                    >
                      {t('Add API connection')}
                    </Button>
                  </Group>
                )}
                {canSetup && catalog && (
                  <Button
                    variant="default"
                    size="xs"
                    mih={44}
                    disabled={!!busy || !catalog.backends.length}
                    onClick={() => setSetup({ catalog: structuredClone(catalog) })}
                  >
                    {t('Add execution backend')}
                  </Button>
                )}
                {saved && (
                  <Text role="status" size="sm" c="dimmed">
                    {catalogStale ||
                    catalog?.connections.some((connection) => connection.restartRequired)
                      ? t('Connection saved. Restart the Buro service to apply it.')
                      : t('Connection saved.')}
                  </Text>
                )}
                {setupSaved && (
                  <Text role="status" size="sm" c="dimmed">
                    {catalogStale ||
                    catalog?.configured?.profiles.some(
                      (item) => item.profile.id === setupSaved && item.restartRequired,
                    )
                      ? t('Team profile saved. Restart the service, then select it explicitly.')
                      : catalog?.profiles.some((item) => item.id === setupSaved) &&
                          catalog.configured?.profiles.some(
                            (item) => item.profile.id === setupSaved && !item.restartRequired,
                          )
                        ? t('Team profile ready. Select it explicitly to use it for new runs.')
                        : t('Team profile saved. Refresh resource settings to check availability.')}
                  </Text>
                )}
                {catalog?.configured?.profiles
                  .filter((item) => item.restartRequired)
                  .map(({ profile }) => (
                    <Paper key={profile.id} withBorder p="sm" data-pending-profile={profile.id}>
                      <Group justify="space-between">
                        <div>
                          <Text size="sm" fw={600}>
                            {profile.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {t('Saved team profile')} · {profile.id}
                          </Text>
                        </div>
                        <Badge color="orange" variant="light">
                          {t('Restart required')}
                        </Badge>
                      </Group>
                    </Paper>
                  ))}
                {catalog?.connections.map((connection) => (
                  <Paper key={connection.id} withBorder p="sm" data-connection-id={connection.id}>
                    <Group justify="space-between" wrap="wrap">
                      <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                        <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
                          {connection.id} ·{' '}
                          {catalog.providers.find((item) => item.id === connection.provider)
                            ?.label || connection.provider}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                          {connection.endpoint}
                        </Text>
                        {connection.restartRequired && connection.activeEndpoint && (
                          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                            {t('Active API: {p0}', { p0: connection.activeEndpoint })}
                          </Text>
                        )}
                      </div>
                      <Group gap="xs">
                        {(connection.restartRequired || catalogStale) && (
                          <Badge variant="light" color="orange">
                            {t('Restart required')}
                          </Badge>
                        )}
                        {!connection.credentialConfigured && (
                          <Badge variant="light" color="orange">
                            {t('Key required')}
                          </Badge>
                        )}
                        <Button
                          size="xs"
                          mih={44}
                          variant="light"
                          loading={busy === connection.id}
                          disabled={
                            !!busy ||
                            catalogStale ||
                            !!connection.restartRequired ||
                            !connection.modelListing ||
                            !connection.credentialConfigured
                          }
                          onClick={() => void discover(connection.id)}
                        >
                          {t('Available models')}
                        </Button>
                        {canConfigure && (
                          <Button
                            size="xs"
                            mih={44}
                            variant="default"
                            aria-label={t('Edit connection {p0}', { p0: connection.id })}
                            disabled={!!busy}
                            onClick={() => setEditing(connection)}
                          >
                            {t('Edit')}
                          </Button>
                        )}
                      </Group>
                    </Group>
                    {!connection.modelListing && (
                      <Text size="xs" c="dimmed">
                        {t(
                          'Model listing is unavailable for this provider. Configure a backend directly.',
                        )}
                      </Text>
                    )}
                    {models[connection.id]?.revision === connection.revision &&
                      !connection.restartRequired &&
                      !catalogStale && (
                        <Stack gap="xs" mt="xs">
                          {models[connection.id].models.length ? (
                            models[connection.id].models.map((model) => (
                              <Group
                                key={model.id}
                                justify="space-between"
                                wrap="wrap"
                                data-model-id={model.id}
                              >
                                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                                  {model.id}
                                </Text>
                                {canSetup &&
                                  catalog.configurationRevision &&
                                  catalog.configured &&
                                  !!model.templates?.length && (
                                    <Button
                                      variant="light"
                                      size="xs"
                                      mih={44}
                                      disabled={!!busy}
                                      onClick={() =>
                                        setSetup({
                                          catalog: structuredClone(catalog),
                                          connectionId: connection.id,
                                          model: model.id,
                                          templates: structuredClone(model.templates),
                                        })
                                      }
                                    >
                                      {t('Use in team')}
                                    </Button>
                                  )}
                              </Group>
                            ))
                          ) : (
                            <Text size="xs">{t('No models were returned by this provider.')}</Text>
                          )}
                        </Stack>
                      )}
                  </Paper>
                ))}
                {catalog?.runtimes
                  .filter((runtime) => catalog.probeRuntimeIds?.includes(runtime.id))
                  .map((runtime) => {
                    const probe = catalog.probes.find(
                      (item) =>
                        item.runtimeId === runtime.id &&
                        item.configurationRevision === runtime.configurationRevision,
                    );
                    const connection = catalog.connections.find(
                      (item) => item.id === runtime.providerId,
                    );
                    return (
                      <Group key={runtime.id} justify="space-between" wrap="wrap">
                        <div>
                          <Text size="sm" fw={selected.has(runtime.id) ? 600 : 400}>
                            {runtime.model}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {runtime.providerId} ·{' '}
                            {connection?.restartRequired || catalogStale
                              ? t('Awaiting restart')
                              : probe?.status === 'passed'
                                ? t('Connection checked')
                                : probe?.status === 'failed'
                                  ? t('Check failed')
                                  : t('Not checked')}
                          </Text>
                        </div>
                        <Button
                          size="xs"
                          mih={44}
                          variant="default"
                          loading={busy === runtime.id}
                          disabled={
                            !!busy ||
                            catalogStale ||
                            !!connection?.restartRequired ||
                            (!!connection && !connection.credentialConfigured)
                          }
                          onClick={() => void check(runtime.id)}
                        >
                          {t('Check model')}
                        </Button>
                      </Group>
                    );
                  })}
                <Text size="xs" c="dimmed">
                  {t('Model checks run a small diagnostic. Repository content is not sent.')}
                </Text>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        {(error || actionError) && (
          <Text role="alert" c="red" size="sm">
            {error || actionError}
          </Text>
        )}
      </Stack>
      {editing !== null && (
        <ApiConnectionForm
          key={editedConnection?.id || 'new'}
          opened
          providers={catalog?.providers || []}
          connection={editedConnection}
          saving={busy === 'save-connection'}
          onClose={() => setEditing(null)}
          onSave={saveConnection}
        />
      )}
      {setup && (
        <ModelTeamSetupForm
          key={(setup.connectionId || 'backend') + ':' + (setup.model || '')}
          {...setup}
          saving={busy === 'setup'}
          onClose={() => setSetup(null)}
          onSave={saveSetup}
        />
      )}
    </section>
  );
}

export function ProjectResourceField({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const { supported, catalog, error, loading, refresh } = useResourceCatalog();
  if (!supported) return null;
  if (!catalog)
    return (
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {t('Execution profile')}
        </Text>
        {error && (
          <Text role="alert" c="red" size="sm">
            {error}
          </Text>
        )}
        <Button variant="light" size="xs" loading={loading} onClick={() => void refresh()}>
          {t('Refresh')}
        </Button>
      </Stack>
    );
  const data = [
    { value: '', label: t('Inherit default profile') },
    ...catalog.profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
  if (value && !data.some((item) => item.value === value))
    data.push({ value, label: value + ' · ' + t('Unavailable') });
  return (
    <Select
      label={t('Execution profile')}
      description={t('Used for new runs and project research.')}
      value={value || ''}
      data={data}
      allowDeselect={false}
      onChange={(id) => onChange(id || undefined)}
    />
  );
}
