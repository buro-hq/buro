import {
  Button,
  Checkbox,
  Collapse,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  TextInput,
} from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { AvailableModel } from '../../../agent/contracts/model.ts';
import type {
  ModelConfigurationInput,
  ModelConfigurationView,
} from '../../../modules/models/model-configuration.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';

/** Edits a connection without starting inference or replacing an omitted credential. */
export const ModelEditor = (input: {
  model?: ModelConfigurationView;
  onClose(): void;
}): ReactElement => {
  const { model: connection, onClose } = input;
  const { client } = useApplication();
  const transports = useApiQuery('models.transports', {});
  const action = useOperation();
  const discovery = useOperation();
  const [name, setName] = useState(connection?.name ?? '');
  const [transport, setTransport] = useState(connection?.transport ?? 'openai-compatible');
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? '');
  const [modelId, setModelId] = useState(connection?.model ?? '');
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [local, setLocal] = useState(connection?.local ?? true);
  const [thinking, setThinking] = useState(connection?.thinking ?? true);
  const [contextTokens, setContextTokens] = useState<string | number>(
    connection?.contextTokens ?? 32768,
  );
  const [outputTokens, setOutputTokens] = useState<string | number>(connection?.outputTokens ?? 8192);
  const [effort, setEffort] = useState(connection?.reasoningEffort ?? '');
  const [capacity, setCapacity] = useState<string | number>(connection?.capacity ?? '');
  const [retries, setRetries] = useState<string | number>(connection?.retries ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [asDefault, setAsDefault] = useState(false);
  const [catalogue, setCatalogue] = useState<AvailableModel[]>([]);
  const configuration = (): ModelConfigurationInput['configuration'] => ({
    id: connection?.id,
    name,
    transport,
    endpoint: endpoint.trim(),
    model: modelId.trim(),
    local,
    thinking,
    contextTokens: Number(contextTokens),
    outputTokens: Number(outputTokens),
    reasoningEffort: effort.trim() || null,
    capacity: capacity === '' ? null : Number(capacity),
    retries: retries === '' ? null : Number(retries),
  });
  const credential = () => (removeKey ? null : key || undefined);
  const discover = async (): Promise<void> => {
    const found = await discovery.perform(async () => {
      const result = await client.call('models.discover', {
        configuration: configuration(),
        apiKey: credential(),
      });
      return { ok: result.ok, error: result.error, value: result.models };
    });
    if (found.value)
      setCatalogue(found.value);
  };
  const save = async (): Promise<void> => {
    const saved = await action.perform(async () => {
      const result = await client.call('models.save', {
        configuration: configuration(),
        apiKey: credential(),
        default: asDefault,
      });
      return { ok: result.ok, error: result.error };
    });
    if (saved.ok)
      onClose();
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={t(connection ? 'Edit model' : 'Add model')}
      size="lg"
    >
      <Stack>
        <TextInput
          label={t('Name')}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Select
          label={t('Transport')}
          value={transport}
          allowDeselect={false}
          onChange={(value) => {
            if (value) {
              setTransport(value);
              setCatalogue([]);
            }
          }}
          data={
            transports.data?.map((item) => ({ value: item.id, label: item.name })) ?? [
              { value: transport, label: transport },
            ]
          }
        />
        <TextInput
          label={t('Base URL · optional for native engines')}
          value={endpoint}
          onChange={(event) => {
            setEndpoint(event.currentTarget.value);
            setCatalogue([]);
          }}
        />
        <PasswordInput
          label={t('API key')}
          placeholder={connection?.hasApiKey ? t('Leave empty to keep the saved key') : ''}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          disabled={removeKey}
          autoComplete="new-password"
        />
        {connection?.hasApiKey && (
          <Checkbox
            label={t('Remove saved key')}
            checked={removeKey}
            onChange={(event) => setRemoveKey(event.currentTarget.checked)}
          />
        )}
        <Group align="end">
          <TextInput
            label={t('Model ID')}
            value={modelId}
            onChange={(event) => setModelId(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button variant="default" loading={discovery.busy} onClick={() => void discover()}>
            {t('Load models')}
          </Button>
        </Group>
        <ErrorNotice error={discovery.error} />
        {catalogue.length > 0 && (
          <Select
            label={t('Available models')}
            searchable
            value={catalogue.some((item) => item.id === modelId) ? modelId : null}
            onChange={(value) => {
              if (value)
                setModelId(value);
            }}
            data={catalogue.map((item) => ({
              value: item.id,
              label: item.name ? `${item.name} · ${item.id}` : item.id,
            }))}
          />
        )}
        <Checkbox
          label={t('Local endpoint')}
          checked={local}
          onChange={(event) => setLocal(event.currentTarget.checked)}
        />
        <Checkbox
          label={t('Thinking')}
          checked={thinking}
          onChange={(event) => setThinking(event.currentTarget.checked)}
        />
        <Button variant="subtle" onClick={() => setAdvanced((value) => !value)}>
          {t('Advanced settings')}
        </Button>
        <Collapse in={advanced}>
          <Stack>
            <Group grow>
              <NumberInput
                label={t('Context tokens')}
                value={contextTokens}
                onChange={setContextTokens}
                min={2}
                allowDecimal={false}
              />
              <NumberInput
                label={t('Output tokens')}
                value={outputTokens}
                onChange={setOutputTokens}
                min={1}
                allowDecimal={false}
              />
            </Group>
            <TextInput
              label={t('Reasoning effort · provider setting')}
              value={effort}
              onChange={(event) => setEffort(event.currentTarget.value)}
            />
            <NumberInput
              label={t('Parallel requests · automatic when empty')}
              value={capacity}
              onChange={setCapacity}
              min={1}
              allowDecimal={false}
            />
            <NumberInput
              label={t('HTTP retries · two when empty')}
              value={retries}
              onChange={setRetries}
              min={0}
              allowDecimal={false}
            />
          </Stack>
        </Collapse>
        <Checkbox
          label={t('Use as application default')}
          checked={asDefault}
          onChange={(event) => setAsDefault(event.currentTarget.checked)}
        />
        <ErrorNotice error={action.error} />
        <Group justify="end">
          <Button variant="default" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
