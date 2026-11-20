import { useState } from 'react';
import { Accordion, Badge, Button, Group, Paper, Select, Stack, Text } from '@mantine/core';
import { useResourceCatalog } from '../../features/resources/useResourceCatalog';
import { t } from '../../i18n/index.ts';

export function ExecutionResources() {
  const { client, supported, catalog, error, loading, refresh } = useResourceCatalog();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [models, setModels] = useState<Record<string, string[]>>({});
  if (!supported) return null;
  const profile = catalog?.profiles.find((item) => item.id === catalog.defaultProfile);
  const selected = new Set(profile ? [profile.coordinator, profile.worker, profile.reviewer] : []);
  async function useProfile(profileId: string) {
    setBusy('profile');
    setActionError('');
    try {
      await client!.command({ method: 'resources.use', params: { profileId } });
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
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
      await refresh();
      setBusy('');
    }
  }
  async function discover(connectionId: string) {
    setBusy(connectionId);
    setActionError('');
    try {
      const result = await client!.command<{ id: string }[]>({
        method: 'resources.models',
        params: { connectionId },
      });
      setModels((current) => ({ ...current, [connectionId]: result.map((model) => model.id) }));
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
        <Button variant="subtle" size="xs" onClick={() => void refresh()} loading={loading}>
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
                  {t(label)}: {resource?.model || (resource?.client === 'codex' ? 'Codex' : id)}
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
                {catalog?.connections.map((connection) => (
                  <Paper key={connection.id} withBorder p="sm">
                    <Group justify="space-between" wrap="wrap">
                      <div>
                        <Text size="sm" fw={600}>
                          {connection.kind === 'ollama' ? 'Ollama' : 'DeepSeek'}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {connection.endpoint}
                        </Text>
                      </div>
                      <Group gap="xs">
                        {connection.kind === 'deepseek' && !connection.credentialConfigured && (
                          <Badge variant="light" color="orange">
                            {t('Key required')}
                          </Badge>
                        )}
                        <Button
                          size="xs"
                          variant="light"
                          loading={busy === connection.id}
                          disabled={
                            !!busy ||
                            (connection.kind === 'deepseek' && !connection.credentialConfigured)
                          }
                          onClick={() => void discover(connection.id)}
                        >
                          {t('Available models')}
                        </Button>
                      </Group>
                    </Group>
                    {models[connection.id] && (
                      <Text size="xs" mt="xs" style={{ overflowWrap: 'anywhere' }}>
                        {models[connection.id].length
                          ? models[connection.id].join(' · ')
                          : t('No installed models. Add a model in Ollama, then refresh.')}
                      </Text>
                    )}
                  </Paper>
                ))}
                {catalog?.runtimes
                  .filter((runtime) => runtime.client === 'managed')
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
                            {probe?.status === 'passed'
                              ? t('Connection checked')
                              : probe?.status === 'failed'
                                ? t('Check failed')
                                : t('Not checked')}
                          </Text>
                        </div>
                        <Button
                          size="xs"
                          variant="default"
                          loading={busy === runtime.id}
                          disabled={
                            !!busy ||
                            (connection?.kind === 'deepseek' && !connection.credentialConfigured)
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
