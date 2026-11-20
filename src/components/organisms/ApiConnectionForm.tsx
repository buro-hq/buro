import { useState } from 'react';
import {
  Accordion,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { ResourceConnectionSchema, type ResourceConnection } from '../../../protocol/resources.ts';
import { t } from '../../i18n/index.ts';

type Props = {
  connection?: ResourceConnection;
  opened: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (connection: ResourceConnection) => Promise<void>;
};

export function ApiConnectionForm({ connection, opened, saving, onClose, onSave }: Props) {
  const [id, setId] = useState(connection?.id || '');
  const [kind, setKind] = useState<'ollama' | 'deepseek'>(connection?.kind || 'ollama');
  const [endpoint, setEndpoint] = useState(connection?.endpoint || 'http://127.0.0.1:11434');
  const [capacity, setCapacity] = useState<string | number>(connection?.capacity || 1);
  const [trust, setTrust] = useState(connection?.kind === 'ollama' ? connection.trust : 'auto');
  const initialThink = connection?.kind === 'ollama' ? connection.think : undefined;
  const [thinkMode, setThinkMode] = useState(
    initialThink === undefined
      ? 'default'
      : typeof initialThink === 'boolean'
        ? String(initialThink)
        : 'custom',
  );
  const [customThink, setCustomThink] = useState(
    typeof initialThink === 'string' ? initialThink : '',
  );
  const [thinking, setThinking] = useState(
    connection?.kind === 'deepseek' ? connection.thinking : 'disabled',
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(
    connection?.kind === 'deepseek' ? connection.apiKeyEnv : 'DEEPSEEK_API_KEY',
  );
  const [error, setError] = useState('');

  async function save() {
    setError('');
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      setError(t('Enter an HTTP or HTTPS API URL without credentials, query or fragment.'));
      return;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      setError(t('Enter an HTTP or HTTPS API URL without credentials, query or fragment.'));
      return;
    }
    const candidate = ResourceConnectionSchema.safeParse({
      id,
      kind,
      endpoint,
      capacity,
      ...(kind === 'ollama'
        ? {
            trust,
            ...(thinkMode === 'default'
              ? {}
              : { think: thinkMode === 'custom' ? customThink : thinkMode === 'true' }),
          }
        : { apiKeyEnv, thinking }),
    });
    if (!candidate.success) {
      const issue = candidate.error.issues[0];
      const messages: Record<string, string> = {
        id: t('Use a lowercase connection ID starting with a letter.'),
        endpoint:
          issue.message === 'Remote DeepSeek endpoints require HTTPS.'
            ? t('Remote DeepSeek endpoints require HTTPS.')
            : t('Enter an HTTP or HTTPS API URL without credentials, query or fragment.'),
        capacity: t('Choose between 1 and 8 concurrent requests.'),
        trust: t('Use a private IP address for your own server, such as 192.168.1.10.'),
        apiKeyEnv: t('Use an uppercase environment variable name, such as DEEPSEEK_API_KEY.'),
      };
      setError(messages[String(issue.path[0])] || issue.message);
      return;
    }
    try {
      await onSave(candidate.data);
    } catch (error) {
      setError(
        error instanceof Error && 'code' in error && error.code === 'RESOURCE_CONNECTION_CONFLICT'
          ? t('This connection changed elsewhere. Cancel, refresh, then edit the latest settings.')
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={connection ? t('Edit API connection') : t('Add API connection')}
      centered
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
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t('Connection ID')}
              description={
                !connection ? t('Lowercase letters, digits, hyphens or underscores.') : undefined
              }
              inputWrapperOrder={['label', 'input', 'description', 'error']}
              value={id}
              onChange={(event) => setId(event.currentTarget.value)}
              placeholder="office-rtx"
              maxLength={64}
              required
              disabled={!!connection || saving}
              styles={{ input: { minHeight: 44 } }}
            />
            <Select
              label={t('API provider')}
              value={kind}
              data={['Ollama', 'DeepSeek'].map((label) => ({
                value: label.toLowerCase(),
                label,
              }))}
              allowDeselect={false}
              disabled={!!connection || saving}
              styles={{ input: { minHeight: 44 } }}
              onChange={(value) => {
                const next = value === 'deepseek' ? 'deepseek' : 'ollama';
                setKind(next);
                setEndpoint(
                  next === 'deepseek' ? 'https://api.deepseek.com' : 'http://127.0.0.1:11434',
                );
                setCapacity(next === 'deepseek' ? 2 : 1);
              }}
            />
          </SimpleGrid>
          <TextInput
            label={t('API base URL')}
            description={t('Buro sends model requests to this address.')}
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            required
            disabled={saving}
            maxLength={1000}
            styles={{ input: { minHeight: 44 } }}
          />
          {kind === 'ollama' ? (
            <Select
              label={t('Server location')}
              description={
                trust === 'private-network'
                  ? t('You trust this private IP as your own server. Eligible for local-only runs.')
                  : trust === 'external'
                    ? t('Requests leave your trusted local environment.')
                    : t('Only this computer is treated as local.')
              }
              value={trust}
              data={[
                { value: 'auto', label: t('Automatic · localhost only') },
                { value: 'private-network', label: t('My server · private network') },
                { value: 'external', label: t('External server') },
              ]}
              onChange={(value) => setTrust((value || 'auto') as typeof trust)}
              allowDeselect={false}
              disabled={saving}
              styles={{ input: { minHeight: 44 } }}
            />
          ) : (
            <TextInput
              label={t('API key environment variable')}
              description={t('Variable name only. Configure its value on the Buro service.')}
              value={apiKeyEnv}
              onChange={(event) => setApiKeyEnv(event.currentTarget.value)}
              required
              disabled={saving}
              maxLength={100}
              styles={{ input: { minHeight: 44 } }}
            />
          )}
          <Accordion variant="contained" transitionDuration={0}>
            <Accordion.Item value="advanced">
              <Accordion.Control>{t('Advanced connection settings')}</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  <NumberInput
                    label={t('Concurrent model requests')}
                    description={t('Maximum simultaneous requests for this connection.')}
                    value={capacity}
                    onChange={setCapacity}
                    min={1}
                    max={8}
                    allowDecimal={false}
                    required
                    disabled={saving}
                    styles={{ input: { minHeight: 44 } }}
                  />
                  <Select
                    label={t('Model reasoning')}
                    value={kind === 'ollama' ? thinkMode : thinking}
                    data={
                      kind === 'ollama'
                        ? [
                            { value: 'default', label: t('Model default') },
                            { value: 'false', label: t('Disabled') },
                            { value: 'true', label: t('Enabled') },
                            { value: 'custom', label: t('Custom reasoning value') },
                          ]
                        : [
                            { value: 'disabled', label: t('Disabled') },
                            { value: 'enabled', label: t('Enabled') },
                          ]
                    }
                    onChange={(value) => {
                      if (kind === 'ollama') setThinkMode(value || 'default');
                      else setThinking(value === 'enabled' ? 'enabled' : 'disabled');
                    }}
                    allowDeselect={false}
                    disabled={saving}
                    styles={{ input: { minHeight: 44 } }}
                  />
                  {kind === 'ollama' && thinkMode === 'custom' && (
                    <TextInput
                      label={t('Reasoning value')}
                      value={customThink}
                      onChange={(event) => setCustomThink(event.currentTarget.value)}
                      maxLength={40}
                      disabled={saving}
                      styles={{ input: { minHeight: 44 } }}
                    />
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Text size="xs" c="dimmed">
            {t(
              'Connection changes apply after a Buro service restart. Active resources keep their current settings.',
            )}
            {!connection &&
              ' ' + t('Then discover models. Execution profiles are configured separately.')}
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
              {t('Save connection')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
