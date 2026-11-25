import {
  Badge,
  Button,
  Collapse,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';

/** Publishing is an explicit user command, separate from completion and local application of changes. */
export const DeliveriesPanel = (input: { runId: string }): ReactElement => {
  const { client } = useApplication();
  const publishers = useApiQuery('deliveries.publishers', {});
  const deliveries = useApiQuery('deliveries.list', {
    runId: input.runId,
  });
  const action = useOperation();
  const [publisherId, setPublisherId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [base, setBase] = useState('');
  const [branch, setBranch] = useState('');
  const [remote, setRemote] = useState('');
  const [advanced, setAdvanced] = useState(false);
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('Publish the run changes as a draft PR. The description is empty unless you enter one.')}
      </Text>
      <Select
        label={t('Publication method')}
        placeholder={t('Default')}
        value={publisherId}
        onChange={setPublisherId}
        clearable
        data={
          publishers.data?.map((publisher) => ({ value: publisher.id, label: publisher.name })) ??
          []
        }
      />
      <TextInput
        label={t('Title · goal title when empty')}
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      <Button variant="subtle" onClick={() => setAdvanced((value) => !value)}>
        {t('Publication options')}
      </Button>
      <Collapse in={advanced}>
        <Stack>
          <TextInput
            label={t('Base branch · remote default when empty')}
            value={base}
            onChange={(event) => setBase(event.currentTarget.value)}
          />
          <TextInput
            label={t('Branch · generated when empty')}
            value={branch}
            onChange={(event) => setBranch(event.currentTarget.value)}
          />
          <TextInput
            label={t('Remote · origin when empty')}
            value={remote}
            onChange={(event) => setRemote(event.currentTarget.value)}
          />
          <Textarea
            label={t('PR description · optional')}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            autosize
            minRows={3}
          />
        </Stack>
      </Collapse>
      <ErrorNotice error={action.error} />
      <Button
        loading={action.busy}
        onClick={() =>
          void action.perform(async () => {
            const result = await client.call('deliveries.publish', {
              runId: input.runId,
              publisherId: publisherId ?? undefined,
              title: title || undefined,
              description: description || undefined,
              base: base || undefined,
              branch: branch || undefined,
              remote: remote || undefined,
            });
            return { ok: result.ok, error: result.error };
          })}
      >
        {t('Publish draft PR')}
      </Button>
      <QueryFeedback loading={deliveries.loading} error={deliveries.error} />
      {deliveries.data?.map((delivery) => (
        <Paper withBorder p="md" key={delivery.id}>
          <Stack gap="sm">
            <Group>
              <Text fw={500}>{delivery.title}</Text>
              <Badge>{t(delivery.status)}</Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {delivery.branch}
              {' '}
              {delivery.commit?.slice(0, 12)}
            </Text>
            {delivery.workspace && (
              <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                {delivery.workspace}
              </Text>
            )}
            <ErrorNotice error={delivery.error} />
            {delivery.url && (
              <Button
                component="a"
                href={delivery.url}
                target="_blank"
                rel="noreferrer"
                variant="light"
              >
                {t('Open PR')}
              </Button>
            )}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
