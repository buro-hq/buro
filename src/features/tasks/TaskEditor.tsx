import { Button, FileInput, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { Task } from '../../../modules/tasks/task.ts';
import { useApplication } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';
import { uploadedFile } from '../materials/upload.ts';

/** Saves user intent and optional attachments without imposing an acceptance form. */
export const TaskEditor = (input: {
  projectId: string;
  task?: Task;
  opened: boolean;
  onClose(): void;
  onSaved(task: Task, start: boolean): void;
}): ReactElement => {
  const { client } = useApplication();
  const action = useOperation();
  const [id, setId] = useState(input.task?.id);
  const [title, setTitle] = useState(input.task?.title ?? '');
  const [description, setDescription] = useState(input.task?.description ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const save = async (start: boolean): Promise<void> => {
    const result = await action.perform(async () => {
      const fields = { projectId: input.projectId, title, description };
      const task = id
        ? await client.call('tasks.update', {
            ...fields,
            id,
          })
        : await client.call('tasks.create', fields);
      if (!task)
        return { ok: false, error: 'Task not found.' };

      setId(task.id);
      for (const file of files) {
        const material = await client.call('materials.upload', {
          projectId: input.projectId,
          taskId: task.id,
          name: file.name,
          contentBase64: await uploadedFile({
            file,
          }),
        });
        if (!material.ok)
          return { ok: false, error: material.error };

        setFiles((previous) => previous.filter((item) => item !== file));
      }
      return { ok: true, value: task };
    });
    if (result.value)
      input.onSaved(result.value, start);
  };
  return (
    <Modal
      opened={input.opened}
      onClose={input.onClose}
      title={t(input.task ? 'Edit goal' : 'New goal')}
      size="lg"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(false);
        }}
      >
        <Stack>
          <TextInput
            label={t('What should we achieve?')}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            required
            autoFocus
          />
          <Textarea
            label={t('Context and expected result')}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            autosize
            minRows={6}
          />
          <FileInput
            multiple
            label={t('Attachments')}
            description={t('Optional')}
            value={files}
            onChange={setFiles}
            clearable
          />
          <ErrorNotice error={action.error} />
          <Group justify="flex-end">
            <Button variant="default" type="submit" loading={action.busy}>
              {t('Save goal')}
            </Button>
            <Button
              loading={action.busy}
              onClick={() => {
                if (title.trim())
                  void save(true);
              }}
            >
              {t('Save and start')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
