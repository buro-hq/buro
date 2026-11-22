import { useState } from 'react';
import { ZodError } from 'zod';
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
  Textarea,
} from '@mantine/core';
import {
  ResourceConnectionSchema,
  type ResourceConnection,
  type ResourceContributionDescriptor,
} from '../../../protocol/resources.ts';
import {
  OllamaConnectionConfigSchema,
  DeepSeekConnectionConfigSchema,
} from '../../../protocol/resource-builtins.ts';
import { t } from '../../i18n/index.ts';

type Props = {
  providers: ResourceContributionDescriptor[];
  connection?: ResourceConnection;
  opened: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (connection: ResourceConnection) => Promise<void>;
};

/** Installed editors are conveniences; the service parser remains authoritative. */
export function ApiConnectionForm({
  providers,
  connection,
  opened,
  saving,
  onClose,
  onSave,
}: Props) {
  const [id, setId] = useState(connection?.id || '');
  const [provider, setProvider] = useState(connection?.provider || providers[0]?.id || '');
  const initial =
    connection?.config || providers.find((item) => item.id === provider)?.defaultConfig || {};
  const [config, setConfig] = useState(initial);
  const [raw, setRaw] = useState(JSON.stringify(initial, null, 2));
  const [error, setError] = useState('');
  const descriptor = providers.find((item) => item.id === provider);
  const editor = descriptor?.editor;
  const builtin = editor === 'ollama' || editor === 'deepseek';
  const patch = (value: Record<string, string | number | boolean>) =>
    setConfig((current) => ({ ...current, ...value }));
  async function save() {
    setError('');
    try {
      let parsed = builtin ? config : JSON.parse(raw);
      if (editor === 'ollama') parsed = OllamaConnectionConfigSchema.parse(parsed);
      if (editor === 'deepseek') parsed = DeepSeekConnectionConfigSchema.parse(parsed);
      await onSave(ResourceConnectionSchema.parse({ id, provider, config: parsed }));
    } catch (error) {
      setError(
        error instanceof Error && 'code' in error && error.code === 'RESOURCE_CONNECTION_CONFLICT'
          ? t('This connection changed elsewhere. Cancel, refresh, then edit the latest settings.')
          : error instanceof SyntaxError
            ? t('Enter a valid JSON object.')
            : error instanceof ZodError
              ? t(
                  error.issues[0]?.message ===
                    'Use an HTTP(S) endpoint without credentials, query or fragment.'
                    ? 'Enter an HTTP or HTTPS API URL without credentials, query or fragment.'
                    : error.issues[0]?.message || 'Check the connection settings.',
                )
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
              value={id}
              onChange={(event) => setId(event.currentTarget.value)}
              placeholder="office-rtx"
              maxLength={64}
              required
              disabled={!!connection || saving}
              mih={44}
            />
            <Select
              label={t('API provider')}
              value={provider}
              data={providers.map((item) => ({ value: item.id, label: item.label }))}
              allowDeselect={false}
              disabled={!!connection || saving}
              onChange={(value) => {
                if (!value) return;
                const next = providers.find((item) => item.id === value)?.defaultConfig || {};
                setProvider(value);
                setConfig(next);
                setRaw(JSON.stringify(next, null, 2));
                setError('');
              }}
            />
          </SimpleGrid>
          {builtin ? (
            <>
              <TextInput
                label={t('API base URL')}
                description={t('Buro sends model requests to this address.')}
                value={String(config.endpoint || '')}
                onChange={(event) => patch({ endpoint: event.currentTarget.value })}
                required
                disabled={saving}
                maxLength={1000}
              />
              {editor === 'ollama' ? (
                <Select
                  label={t('Server location')}
                  description={
                    config.trust === 'private-network'
                      ? t(
                          'You trust this private IP as your own server. Eligible for local-only runs.',
                        )
                      : config.trust === 'external'
                        ? t('Requests leave your trusted local environment.')
                        : t('Only this computer is treated as local.')
                  }
                  value={String(config.trust || 'auto')}
                  data={[
                    { value: 'auto', label: t('Automatic · localhost only') },
                    { value: 'private-network', label: t('My server · private network') },
                    { value: 'external', label: t('External server') },
                  ]}
                  onChange={(value) => patch({ trust: value || 'auto' })}
                  allowDeselect={false}
                  disabled={saving}
                />
              ) : (
                <TextInput
                  label={t('API key environment variable')}
                  description={t('Variable name only. Configure its value on the Buro service.')}
                  value={String(config.apiKeyEnv || '')}
                  onChange={(event) => patch({ apiKeyEnv: event.currentTarget.value })}
                  maxLength={100}
                  required
                  disabled={saving}
                />
              )}
              <Accordion variant="contained" transitionDuration={0}>
                <Accordion.Item value="advanced">
                  <Accordion.Control>{t('Advanced connection settings')}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <NumberInput
                        label={t('Concurrent model requests')}
                        value={typeof config.capacity === 'number' ? config.capacity : 1}
                        onChange={(value) => patch({ capacity: Number(value) })}
                        min={1}
                        max={8}
                        allowDecimal={false}
                        required
                        disabled={saving}
                      />
                      {editor === 'ollama' ? (
                        <>
                          <Select
                            label={t('Model reasoning')}
                            value={
                              config.think === undefined
                                ? 'default'
                                : typeof config.think === 'boolean'
                                  ? String(config.think)
                                  : 'custom'
                            }
                            data={[
                              { value: 'default', label: t('Model default') },
                              { value: 'false', label: t('Disabled') },
                              { value: 'true', label: t('Enabled') },
                              { value: 'custom', label: t('Custom reasoning value') },
                            ]}
                            onChange={(value) =>
                              setConfig((current) => {
                                const next = { ...current };
                                if (value === 'default') delete next.think;
                                else next.think = value === 'custom' ? '' : value === 'true';
                                return next;
                              })
                            }
                            allowDeselect={false}
                            disabled={saving}
                          />
                          {typeof config.think === 'string' && (
                            <TextInput
                              label={t('Reasoning value')}
                              value={config.think}
                              onChange={(event) => patch({ think: event.currentTarget.value })}
                              maxLength={40}
                              disabled={saving}
                            />
                          )}
                        </>
                      ) : (
                        <Select
                          label={t('Model reasoning')}
                          value={String(config.thinking || 'disabled')}
                          data={[
                            { value: 'disabled', label: t('Disabled') },
                            { value: 'enabled', label: t('Enabled') },
                          ]}
                          onChange={(value) => patch({ thinking: value || 'disabled' })}
                          allowDeselect={false}
                          disabled={saving}
                        />
                      )}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </>
          ) : (
            <Textarea
              label={t('Provider configuration (JSON)')}
              description={t(
                'Configuration is validated by the installed provider. Use credential references, never secret values.',
              )}
              value={raw}
              onChange={(event) => setRaw(event.currentTarget.value)}
              minRows={7}
              maxRows={15}
              autosize
              maxLength={64000}
              disabled={saving}
              spellCheck={false}
              styles={{ input: { fontFamily: 'monospace' } }}
            />
          )}
          <Text size="xs" c="dimmed">
            {t(
              'Connection changes apply after a Buro service restart. Active resources keep their current settings.',
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
              {t('Save connection')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
