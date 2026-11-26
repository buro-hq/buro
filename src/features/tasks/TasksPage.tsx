import {
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Checkbox,
} from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { Task } from '../../../modules/tasks/task.ts';
import type { RunOptions } from '../../../modules/runs/run.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { Panel, ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';
import { TaskEditor } from './TaskEditor.tsx';
import { LaunchOptionsEditor } from '@/entities/run';
import { PresetSelector } from '@/entities/preset';
import type { LaunchOptions } from '#shared/contracts';

/** Owns task editing and explicit run options; it never reconstructs server state from events. */
export const TasksPage = (input: { projectId: string; onRun(id: string): void }): ReactElement => {
  const { client } = useApplication();
  const tasks = useApiQuery('tasks.list', {
    projectId: input.projectId,
  });
  const models = useApiQuery('models.list', {});
  const settings = useApiQuery('settings.get', {});
  const action = useOperation();
  const [editor, setEditor] = useState<{ task?: Task }>();
  const [presetId, setPresetId] = useState<string | null>(null);
  const [options, setOptions] = useState<LaunchOptions>({});
  const [readOnly, setReadOnly] = useState(false);
  const start = async (taskId: string): Promise<void> => {
    const launch: RunOptions = {
      ...options,
      ...(readOnly ? { readOnly: true } : {}),
    };
    const result = await action.perform(async () => {
      const started = await client.call('runs.start', {
        taskId,
        options: launch,
      });
      return { ok: started.ok, value: started.run, error: started.error };
    });
    if (result.value)
      input.onRun(result.value.id);
  };
  return (
    <Panel
      title={t('Goals')}
      description={t('Describe the result. The agent chooses its tools and collaborators.')}
      aside={<Button onClick={() => setEditor({})}>{t('New goal')}</Button>}
    >
      <Stack>
        <PresetSelector
          value={presetId}
          onChange={({ id, options: copied }) => {
            setPresetId(id);
            setOptions(copied);
          }}
        />
        <QueryFeedback loading={models.loading || settings.loading} error={models.error ?? settings.error} />
        <LaunchOptionsEditor
          value={options}
          models={models.data ?? []}
          reviewDefaults={settings.data?.review}
          onChange={setOptions}
          collapsible
        />
        <Checkbox
          label={t('Read-only workspace')}
          checked={readOnly}
          onChange={(event) => setReadOnly(event.currentTarget.checked)}
        />
        <ErrorNotice error={action.error} />
        <QueryFeedback loading={tasks.loading} error={tasks.error} />
        {tasks.data?.length === 0 && <Text c="dimmed">{t('No goals yet')}</Text>}
        {tasks.data
          ?.slice()
          .reverse()
          .map((task) => (
            <Paper key={task.id} withBorder p="md">
              <Stack gap="sm">
                <Text fw={600}>{task.title}</Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {task.description}
                </Text>
                <Group>
                  <Button loading={action.busy} onClick={() => void start(task.id)}>
                    {t('Start run')}
                  </Button>
                  <Button
                    variant="default"
                    onClick={() => setEditor({
                      task,
                    })}
                  >
                    {t('Edit')}
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      void action.perform(async () => {
                        await client.call('tasks.delete', {
                          id: task.id,
                        });
                        return { ok: true };
                      })}
                  >
                    {t('Delete')}
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ))}
      </Stack>
      {editor && (
        <TaskEditor
          key={editor.task?.id ?? 'new'}
          projectId={input.projectId}
          task={editor.task}
          opened
          onClose={() => setEditor(undefined)}
          onSaved={(task, shouldStart) => {
            setEditor(undefined);
            if (shouldStart)
              void start(task.id);
          }}
        />
      )}
    </Panel>
  );
};
