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
export function ModelEditor(input: {
  model?: ModelConfigurationView;
  onClose(): void;
}): ReactElement {
  const { client } = useApplication(),
    transports = useApiQuery('models.transports', {}),
    action = useOperation(),
    discovery = useOperation();
  const [name, setName] = useState(input.model?.name ?? ''),
    [transport, setTransport] = useState(input.model?.transport ?? 'openai-compatible'),
    [endpoint, setEndpoint] = useState(input.model?.endpoint ?? ''),
    [model, setModel] = useState(input.model?.model ?? ''),
    [key, setKey] = useState(''),
    [removeKey, setRemoveKey] = useState(false),
    [local, setLocal] = useState(input.model?.local ?? true),
    [thinking, setThinking] = useState(input.model?.thinking ?? true),
    [contextTokens, setContextTokens] = useState<string | number>(
      input.model?.contextTokens ?? 32768,
    ),
    [outputTokens, setOutputTokens] = useState<string | number>(input.model?.outputTokens ?? 8192),
    [effort, setEffort] = useState(input.model?.reasoningEffort ?? ''),
    [capacity, setCapacity] = useState<string | number>(input.model?.capacity ?? ''),
    [retries, setRetries] = useState<string | number>(input.model?.retries ?? ''),
    [advanced, setAdvanced] = useState(false),
    [asDefault, setAsDefault] = useState(false),
    [catalogue, setCatalogue] = useState<AvailableModel[]>([]);
  function configuration(): ModelConfigurationInput['configuration'] {
    return {
      id: input.model?.id,
      name,
      transport,
      endpoint: endpoint.trim(),
      model: model.trim(),
      local,
      thinking,
      contextTokens: Number(contextTokens),
      outputTokens: Number(outputTokens),
      reasoningEffort: effort.trim() || null,
      capacity: capacity === '' ? null : Number(capacity),
      retries: retries === '' ? null : Number(retries),
    };
  }
  const credential = () => (removeKey ? null : key || undefined);
  async function discover(): Promise<void> {
    const found = await discovery.perform(async () => {
      const result = await client.call('models.discover', {
        configuration: configuration(),
        apiKey: credential(),
      });
      return { ok: result.ok, error: result.error, value: result.models };
    });
    if (found.value) setCatalogue(found.value);
  }
  async function save(): Promise<void> {
    const saved = await action.perform(async () => {
      const result = await client.call('models.save', {
        configuration: configuration(),
        apiKey: credential(),
        default: asDefault,
      });
      return { ok: result.ok, error: result.error };
    });
    if (saved.ok) input.onClose();
  }
  return (
    <Modal
      opened
      onClose={input.onClose}
      title={t(input.model ? 'Edit model' : 'Add model')}
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
          placeholder={input.model?.hasApiKey ? t('Leave empty to keep the saved key') : ''}
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
          disabled={removeKey}
          autoComplete="new-password"
        />
        {input.model?.hasApiKey && (
          <Checkbox
            label={t('Remove saved key')}
            checked={removeKey}
            onChange={(event) => setRemoveKey(event.currentTarget.checked)}
          />
        )}
        <Group align="end">
          <TextInput
            label={t('Model ID')}
            value={model}
            onChange={(event) => setModel(event.currentTarget.value)}
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
            value={catalogue.some((item) => item.id === model) ? model : null}
            onChange={(value) => {
              if (value) setModel(value);
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
          <Button variant="default" onClick={input.onClose}>
            {t('Cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
