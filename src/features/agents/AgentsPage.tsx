import { Button, Group, Modal, Paper, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { Agent } from '../../../modules/agents/agent.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { Panel } from '../../components/molecules/Panel.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';

function AgentEditor(input: { agent?: Agent; onClose(): void }): ReactElement {
  const { client } = useApplication();
  const action = useOperation();
  const [name, setName] = useState(input.agent?.name ?? '');
  const [description, setDescription] = useState(input.agent?.description ?? '');
  const [instructions, setInstructions] = useState(input.agent?.instructions ?? '');
  const [tools, setTools] = useState(input.agent?.tools?.join(', ') ?? '');
  async function save(): Promise<void> {
    const result = await action.perform(async () => {
      await client.call('agents.save', {
        id: input.agent?.id,
        name,
        description,
        instructions,
        tools: tools.trim()
          ? tools
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined,
      });
      return { ok: true };
    });
    if (result.ok)
      input.onClose();
  }
  return (
    <Modal opened onClose={input.onClose} title={t('Agent')} size="lg">
      <Stack>
        <TextInput
          label={t('Name')}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <TextInput
          label={t('Description')}
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <Textarea
          label={t('Instructions')}
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          autosize
          minRows={6}
        />
        <TextInput
          label={t('Tools · comma separated, all when empty')}
          value={tools}
          onChange={(event) => setTools(event.currentTarget.value)}
        />
        <ErrorNotice error={action.error} />
        <Group justify="end">
          <Button variant="default" onClick={input.onClose}>
            {t('Cancel')}
          </Button>
          <Button loading={action.busy} onClick={() => void save()}>
            {t('Save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Reusable collaborators are ordinary descriptions, without reserved names or phases. */
export function AgentsPage(): ReactElement {
  const { client } = useApplication();
  const agents = useApiQuery('agents.list', {});
  const action = useOperation();
  const [editor, setEditor] = useState<{ agent?: Agent }>();
  return (
    <Panel
      title={t('Agents')}
      description={t(
        'Optional reusable instructions. An agent can also create a collaborator directly.',
      )}
      aside={<Button onClick={() => setEditor({})}>{t('Add agent')}</Button>}
    >
      <Stack>
        <QueryFeedback loading={agents.loading} error={agents.error} />
        <ErrorNotice error={action.error} />
        {agents.data?.length === 0 && <Text c="dimmed">{t('No saved agents yet')}</Text>}
        {agents.data?.map((agent) => (
          <Paper key={agent.id} withBorder p="md">
            <Stack gap="sm">
              <Text fw={600}>{agent.name}</Text>
              <Text size="sm">{agent.description}</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {agent.instructions}
              </Text>
              <Group>
                <Button
                  variant="default"
                  onClick={() => setEditor({
                    agent,
                  })}
                >
                  {t('Edit')}
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  onClick={() =>
                    void action.perform(async () => {
                      await client.call('agents.delete', {
                        id: agent.id,
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
        <AgentEditor
          key={editor.agent?.id ?? 'new'}
          agent={editor.agent}
          onClose={() => setEditor(undefined)}
        />
      )}
    </Panel>
  );
}
