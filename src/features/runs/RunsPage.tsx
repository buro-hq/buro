import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { useApiQuery } from '../../data/application.tsx';
import { Panel } from '../../components/molecules/Panel.tsx';
import { t } from '../../i18n/index.ts';
import { QueryFeedback } from '../common/feedback.tsx';
import { RunDetail } from './RunDetail.tsx';

/** Reads attempts independently from editable goals and reusable agent descriptions. */
export function RunsPage(input: {
  projectId: string;
  selectedId?: string;
  onSelect(id?: string): void;
}): ReactElement {
  const runs = useApiQuery('runs.list', { projectId: input.projectId }),
    tasks = useApiQuery('tasks.list', { projectId: input.projectId });
  return (
    <Panel title={t('Runs')}>
      {input.selectedId ? (
        <RunDetail
          key={input.selectedId}
          id={input.selectedId}
          onRun={input.onSelect}
          onBack={() => input.onSelect(undefined)}
        />
      ) : (
        <Stack>
          <QueryFeedback loading={runs.loading} error={runs.error} />
          {runs.data?.length === 0 && <Text c="dimmed">{t('No runs yet')}</Text>}
          {runs.data
            ?.slice()
            .reverse()
            .map((run) => (
              <Paper withBorder p="md" key={run.id}>
                <Group justify="space-between">
                  <div>
                    <Text fw={600}>
                      {tasks.data?.find((task) => task.id === run.taskId)?.title ?? run.taskId}
                    </Text>
                    <Text c="dimmed" size="xs">
                      {new Date(run.createdAt).toLocaleString()} · {run.id.slice(0, 8)}
                    </Text>
                  </div>
                  <Group>
                    <Badge variant="light">{t(run.status)}</Badge>
                    <Button variant="default" onClick={() => input.onSelect(run.id)}>
                      {t('Open')}
                    </Button>
                  </Group>
                </Group>
              </Paper>
            ))}
        </Stack>
      )}
    </Panel>
  );
}
