import { Badge, Group, Paper, Select, Stack, Text } from '@mantine/core';
import { useEffect, useState, type ReactElement } from 'react';
import type { Session } from '../../../modules/sessions/session.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';

/** Displays portable conversation history and provisional text separately. */
export function SessionView(input: { session: Session }): ReactElement {
  const { client } = useApplication(),
    models = useApiQuery('models.list', {}),
    action = useOperation();
  const [stream, setStream] = useState('');
  useEffect(
    () =>
      client.subscribe((notice) => {
        const data = notice.data as { sessionId?: string; id?: string; text?: string };
        if (
          notice.type === 'session.text' &&
          data.sessionId === input.session.id &&
          typeof data.text === 'string'
        )
          setStream((previous) => previous + data.text);
        if (notice.type === 'session.updated' && data.id === input.session.id) setStream('');
        if (notice.type === 'session.retry' && data.sessionId === input.session.id) setStream('');
      }),
    [client, input.session.id],
  );
  return (
    <Stack>
      <Group>
        <Badge variant="light">{t(input.session.status)}</Badge>
        <Text size="xs" c="dimmed">
          {input.session.id}
        </Text>
      </Group>
      <Select
        label={t('Model for the next request')}
        value={input.session.modelId}
        data={[
          ...(models.data?.map((model) => ({ value: model.id, label: model.name })) ?? []),
          ...(!models.data?.some((model) => model.id === input.session.modelId)
            ? [{ value: input.session.modelId, label: input.session.modelId }]
            : []),
        ]}
        onChange={(modelId) => {
          if (modelId)
            void action.perform(async () => ({
              ok: await client.call('sessions.model', { sessionId: input.session.id, modelId }),
              error: t('Model unavailable'),
            }));
        }}
      />
      <ErrorNotice error={action.error ?? input.session.error} />
      {input.session.usage && (
        <Text size="xs" c="dimmed">
          {t('Reported tokens')} · {t('Input')}: {input.session.usage.inputTokens ?? '—'} ·{' '}
          {t('Output')}: {input.session.usage.outputTokens ?? '—'}
        </Text>
      )}
      {input.session.messages
        .filter((message) => message.role !== 'system')
        .map((message, index) => (
          <Paper key={message.id ?? index} withBorder p="md">
            <Stack gap="xs">
              <Text size="xs" fw={600}>
                {t(message.role)}
                {message.toolName ? ` · ${message.toolName}` : ''}
              </Text>
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
}
