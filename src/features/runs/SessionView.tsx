import { Badge, Button, Group, Paper, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState, type ReactElement } from 'react';
import type { Session } from '../../../modules/sessions/session.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';
import { useSessionHistory } from './use-session-history.ts';

/** Displays portable conversation history and provisional text separately. */
export const SessionView = (input: { session: Session }): ReactElement => {
  const { session } = input;
  const { id: sessionId, modelId, status, error, usage } = session;
  const { client } = useApplication();
  const models = useApiQuery('models.list', {});
  const action = useOperation();
  const [stream, setStream] = useState('');
  const history = useSessionHistory({
    sessionId,
  });
  useEffect(
    () =>
      client.subscribe((notice) => {
        const data = notice.data as { sessionId?: string; id?: string; text?: string };
        const isCurrentText = notice.type === 'session.text' && data.sessionId === sessionId;
        const text = data.text;
        const hasText = typeof text === 'string';
        if (isCurrentText && hasText)
          setStream((previous) => previous + text);

        const messagesChanged = notice.type === 'session.messages' && data.id === sessionId;
        if (messagesChanged)
          setStream('');

        const requestRestarted = notice.type === 'session.retry' && data.sessionId === sessionId;
        if (requestRestarted)
          setStream('');
      }),
    [client, sessionId],
  );
  return (
    <Stack>
      <Group>
        <Badge variant="light">{t(status)}</Badge>
        <Text size="xs" c="dimmed">
          {sessionId}
        </Text>
      </Group>
      <Select
        label={t('Model for the next request')}
        value={modelId}
        data={[
          ...(models.data?.map((model) => ({ value: model.id, label: model.name })) ?? []),
          ...(!models.data?.some((model) => model.id === modelId)
            ? [{ value: modelId, label: modelId }]
            : []),
        ]}
        onChange={(nextModelId) => {
          if (nextModelId)
            void action.perform(async () => ({
              ok: await client.call('sessions.model', {
                sessionId: sessionId,
                modelId: nextModelId,
              }),
              error: t('Model unavailable'),
            }));
        }}
      />
      <ErrorNotice error={action.error ?? error} />
      {usage && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">{t('Reported tokens')}</Text>
          <Group gap="sm">
            <Text size="xs" c="dimmed">{t('Input')}: {usage.inputTokens ?? '—'}</Text>
            <Text size="xs" c="dimmed">{t('Output')}: {usage.outputTokens ?? '—'}</Text>
          </Group>
        </Stack>
      )}
      <QueryFeedback loading={history.loading} error={history.error} />
      {!!history.data?.start && (
        <Button
          variant="subtle"
          loading={history.loadingEarlier}
          onClick={() => void history.earlier()}
        >
          {t('Load earlier messages')}
        </Button>
      )}
      {history.data?.messages
        .filter((message) => message.role !== 'system')
        .map((message, index) => (
          <Paper key={message.id ?? index} withBorder p="md">
            <Stack gap="xs">
              <Group gap="sm">
                <Text size="xs" fw={600}>{t(message.role)}</Text>
                {message.toolName && <Badge variant="light">{message.toolName}</Badge>}
              </Group>
              {message.content && <pre className="feature-pre">{message.content}</pre>}
              {message.toolCalls?.map((call) => (
                <details key={call.id}>
                  <summary>{call.name}</summary>
                  <pre className="feature-pre">{JSON.stringify(call.arguments, null, 2)}</pre>
                </details>
              ))}
            </Stack>
          </Paper>
        ))}
      {stream && (
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            {t('Generating…')}
          </Text>
          <pre className="feature-pre">{stream}</pre>
        </Paper>
      )}
    </Stack>
  );
};
