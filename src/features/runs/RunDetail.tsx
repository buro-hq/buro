import { Badge, Button, Group, Paper, Select, Stack, Tabs, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';
import { SessionView } from './SessionView.tsx';

function Changes(input: { runId: string }): ReactElement {
  const { client } = useApplication(),
    changes = useApiQuery('results.inspect', { runId: input.runId }),
    action = useOperation();
  return (
    <Stack>
      <QueryFeedback loading={changes.loading} error={changes.error ?? changes.data?.error} />
      <ErrorNotice error={action.error} />
      {changes.data?.files?.map((file) => (
        <Text key={file.path} size="sm">
          {file.status} · {file.path}
        </Text>
      ))}
      <pre className="feature-pre feature-patch">{changes.data?.patch}</pre>
      {changes.data?.ok && (
        <Button
          loading={action.busy}
          disabled={!changes.data.files?.length}
          onClick={() =>
            void action.perform(async () => {
              const applied = await client.call('results.apply', {
                runId: input.runId,
                revision: changes.data?.revision,
              });
              return { ok: applied.ok, error: applied.error };
            })
          }
        >
          {t('Apply changes to project')}
        </Button>
      )}
    </Stack>
  );
}

/** A run owns its workspace and sessions; combining its result stays an explicit user action. */
export function RunDetail(input: {
  id: string;
  onRun(id: string): void;
  onBack(): void;
}): ReactElement {
  const { client } = useApplication(),
    run = useApiQuery('runs.get', { id: input.id }),
    sessions = useApiQuery('sessions.list', { runId: input.id }),
    action = useOperation();
  const [sessionId, setSessionId] = useState<string | null>(null),
    [tab, setTab] = useState<string | null>('conversation');
  const selected =
    sessions.data?.find((session) => session.id === sessionId) ??
    sessions.data?.find((session) => session.id === run.data?.sessionId) ??
    sessions.data?.[0];
  return (
    <Stack>
      <Group justify="space-between">
        <Button variant="subtle" onClick={input.onBack}>
          {t('All runs')}
        </Button>
        <Group>
          {run.data && <Badge>{t(run.data.status)}</Badge>}
          <Button
            loading={action.busy}
            variant="default"
            onClick={() =>
              void action.perform(async () => {
                await client.call('runs.cancel', { id: input.id });
                return { ok: true };
              })
            }
          >
            {t('Stop')}
          </Button>
          <Button
            loading={action.busy}
            onClick={() =>
              void action.perform(async () => {
                const result = await client.call('runs.retry', { id: input.id });
                if (result.run) input.onRun(result.run.id);
                return { ok: result.ok, error: result.error };
              })
            }
          >
            {t('New attempt with saved work')}
          </Button>
        </Group>
      </Group>
      <QueryFeedback loading={run.loading} error={run.error} />
      <ErrorNotice error={action.error ?? run.data?.error} />
      {run.data && (
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            {run.data.id}
          </Text>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {run.data.workspace}
          </Text>
          {run.data.result && <pre className="feature-pre">{run.data.result}</pre>}
        </Paper>
      )}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="conversation">{t('Conversations')}</Tabs.Tab>
          <Tabs.Tab value="changes">{t('Changes')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="conversation" pt="md">
          <Stack>
            <QueryFeedback loading={sessions.loading} error={sessions.error} />
            <Select
              label={t('Session')}
              value={selected?.id ?? null}
              onChange={setSessionId}
              data={
                sessions.data?.map((session) => ({
                  value: session.id,
                  label: `${session.parentId ? t('Collaborator') : t('Main conversation')} · ${t(session.status)} · ${session.id.slice(0, 8)}`,
                })) ?? []
              }
            />
            {selected && <SessionView key={selected.id} session={selected} />}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="changes" pt="md">
          {tab === 'changes' && <Changes runId={input.id} />}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
