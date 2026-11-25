import {
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  Checkbox,
  Collapse,
} from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { Task } from '../../../modules/tasks/task.ts';
import type { RunOptions } from '../../../modules/runs/run.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { Panel, ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';
import { TaskEditor } from './TaskEditor.tsx';
import { ReviewEditor } from '@/features/run-review';
import type { ReviewSettings } from '#shared/contracts';

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
  const [advanced, setAdvanced] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [reviewMode, setReviewMode] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewSettings>({});
  const start = async (taskId: string): Promise<void> => {
    const options: RunOptions = {
      ...(modelId ? { modelId } : {}),
      ...(instructions ? { instructions } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(reviewMode ? { review: { ...review, enabled: reviewMode === 'enabled' } } : {}),
    };
    const result = await action.perform(async () => {
      const started = await client.call('runs.start', {
        taskId,
        options,
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
        <Group>
          <Select
            label={t('Model')}
            placeholder={t('Application default')}
            clearable
            value={modelId}
            onChange={setModelId}
            data={(models.data ?? []).map((model) => ({ value: model.id, label: model.name }))}
            miw={240}
          />
          <Button variant="subtle" mt="auto" onClick={() => setAdvanced((value) => !value)}>
            {t('Run options')}
          </Button>
        </Group>
        <Collapse in={advanced}>
          <Stack>
            <Textarea
              label={t('Instructions override')}
              description={t('Optional')}
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              autosize
              minRows={3}
            />
            <Checkbox
              label={t('Read-only workspace')}
              checked={readOnly}
              onChange={(event) => setReadOnly(event.currentTarget.checked)}
            />
            <Select
              label={t('Automatic team review')}
              placeholder={t('Application default')}
              clearable
              value={reviewMode}
              onChange={setReviewMode}
              data={[
                { value: 'enabled', label: t('Enabled') },
                { value: 'disabled', label: t('Disabled') },
              ]}
            />
            {reviewMode === 'enabled' && (
              <ReviewEditor
                value={{ ...settings.data?.review, ...review, enabled: true }}
                models={models.data ?? []}
                onChange={setReview}
              />
            )}
          </Stack>
        </Collapse>
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
