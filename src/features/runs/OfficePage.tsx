import { Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import { useApiQuery } from '../../data/application.tsx';
import { Panel } from '../../components/molecules/Panel.tsx';
import { t } from '../../i18n/index.ts';
import { QueryFeedback } from '../common/feedback.tsx';

/** The office follows actual sessions, with no reserved desks, names or team size. */
export const OfficePage = (input: { projectId: string; onRun(id: string): void }): ReactElement => {
  const runs = useApiQuery('runs.list', {
    projectId: input.projectId,
  });
  const agents = useApiQuery('agents.list', {});
  const models = useApiQuery('models.list', {});
  const [runId, setRunId] = useState<string | null>(null);
  const run =
    runs.data?.find((candidate) => candidate.id === runId) ??
    runs.data
      ?.slice()
      .reverse()
      .find((candidate) => candidate.status === 'running') ??
      runs.data?.at(-1);
  const sessions = useApiQuery('sessions.list', run ? { runId: run.id } : undefined);
  return (
    <Panel
      title={t('Office')}
      description={t('Conversations and collaborators in the selected run.')}
      aside={
        run && (
          <Button variant="default" onClick={() => input.onRun(run.id)}>
            {t('Open run')}
          </Button>
        )
      }
    >
      <Stack>
        <QueryFeedback
          loading={runs.loading || sessions.loading}
          error={runs.error ?? sessions.error}
        />
        <Select
          label={t('Run')}
          value={run?.id ?? null}
          onChange={setRunId}
          data={
            runs.data?.map((candidate) => ({
              value: candidate.id,
              label: `${candidate.title ?? candidate.taskId} · ${t(candidate.status)} · ${candidate.id.slice(0, 8)}`,
            })) ?? []
          }
        />
        {!run && <Text c="dimmed">{t('Start a goal to see its agents here.')}</Text>}
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
          {sessions.data?.map((session) => {
            const agent = agents.data?.find((candidate) => candidate.id === session.agentId);
            const model = models.data?.find((candidate) => candidate.id === session.modelId);
            const latest = session.preview;
            return (
              <Paper withBorder p="md" key={session.id}>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text fw={600}>
                      {agent?.name ?? t(session.parentId ? 'Collaborator' : 'Main conversation')}
                    </Text>
                    <Badge variant="light">{t(session.status)}</Badge>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {model?.name ?? session.modelId}
                  </Text>
                  <Text size="sm" lineClamp={5} style={{ whiteSpace: 'pre-wrap' }}>
                    {session.error ?? latest ?? t('Waiting for the first response')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {session.id.slice(0, 8)} · {new Date(session.updatedAt).toLocaleTimeString()}
                  </Text>
                  <Button variant="subtle" onClick={() => input.onRun(session.runId ?? run!.id)}>
                    {t('Open conversation')}
                  </Button>
                </Stack>
              </Paper>
            );
          })}
        </SimpleGrid>
      </Stack>
    </Panel>
  );
};
