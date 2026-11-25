import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { Project } from '../../../modules/projects/project.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { useOperation } from '../common/operation.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';

/** Chooses a source directory without requiring a model, team or execution profile. */
export const ProjectPicker = (input: {
  opened: boolean;
  onClose(): void;
  onSelect(project: Project): void;
}): ReactElement => {
  const { client } = useApplication();
  const projects = useApiQuery('projects.list', {});
  const action = useOperation();
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const connect = async (): Promise<void> => {
    const result = await action.perform(async () => {
      const connected = await client.call('projects.connect', {
        root,
        name: name || undefined,
      });
      return { ok: connected.ok, value: connected.project, error: connected.error };
    });
    if (result.value) {
      input.onSelect(result.value);
      input.onClose();
      setRoot('');
      setName('');
    }
  };
  return (
    <Modal opened={input.opened} onClose={input.onClose} title={t('Projects')} size="lg">
      <Stack>
        <QueryFeedback loading={projects.loading} error={projects.error} />
        {projects.data?.map((project) => (
          <Group key={project.id} justify="space-between" wrap="nowrap">
            <div>
              <Text fw={500}>{project.name}</Text>
              <Text size="xs" c="dimmed">
                {project.root}
              </Text>
            </div>
            <Group>
              <Button
                variant="light"
                onClick={() => {
                  input.onSelect(project);
                  input.onClose();
                }}
              >
                {t('Choose')}
              </Button>
              <Button
                variant="subtle"
                color="red"
                onClick={() =>
                  void action.perform(async () => {
                    await client.call('projects.disconnect', {
                      id: project.id,
                    });
                    return { ok: true };
                  })}
              >
                {t('Disconnect')}
              </Button>
            </Group>
          </Group>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <Stack mt="md">
            <TextInput
              label={t('Project directory')}
              value={root}
              onChange={(event) => setRoot(event.currentTarget.value)}
              required
              placeholder="/path/to/project"
            />
            <TextInput
              label={t('Name')}
              description={t('Optional')}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <ErrorNotice error={action.error} />
            <Button type="submit" loading={action.busy}>
              {t('Connect project')}
            </Button>
          </Stack>
        </form>
      </Stack>
    </Modal>
  );
};
