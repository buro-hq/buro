import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { ModelConfigurationView } from '../../../modules/models/model-configuration.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { Panel } from '@/shared/ui';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';
import { ModelEditor } from './ModelEditor.tsx';

/** Connections are application-wide; choosing a model never requires a project profile. */
export const ModelsPage = (): ReactElement => {
  const { client } = useApplication();
  const models = useApiQuery('models.list', {});
  const settings = useApiQuery('settings.get', {});
  const action = useOperation();
  const [editor, setEditor] = useState<{ model?: ModelConfigurationView }>();
  return (
    <Panel
      title={t('Models')}
      description={t('Choose a default. Agents can change models within a conversation.')}
      aside={<Button onClick={() => setEditor({})}>{t('Add model')}</Button>}
    >
      <Stack>
        <QueryFeedback loading={models.loading} error={models.error} />
        <ErrorNotice error={action.error} />
        {models.data?.length === 0 && (
          <Text c="dimmed">{t('Add a model connection to start a run.')}</Text>
        )}
        {models.data?.map((model) => (
          <Paper withBorder p="md" key={model.id}>
            <Stack gap="sm">
              <Group>
                <Text fw={600}>{model.name}</Text>
                {settings.data?.defaultModelId === model.id && <Badge>{t('Default')}</Badge>}
                {model.thinking && <Badge variant="light">{t('Thinking')}</Badge>}
              </Group>
              <Group gap="sm">
                <Badge variant="outline">{model.transport}</Badge>
                <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{model.model}</Text>
              </Group>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {model.endpoint}
              </Text>
              {!model.available && <Text c="red">{t('Transport unavailable')}</Text>}
              <Group>
                <Button
                  variant="default"
                  onClick={() => setEditor({
                    model,
                  })}
                >
                  {t('Edit')}
                </Button>
                <Button
                  variant="subtle"
                  loading={action.busy}
                  onClick={() =>
                    void action.perform(async () => ({
                      ok: await client.call('models.default', {
                        id: model.id,
                      }),
                      error: t('Transport unavailable'),
                    }))}
                >
                  {t('Use as default')}
                </Button>
                <Button
                  color="red"
                  variant="subtle"
                  onClick={() =>
                    void action.perform(async () => {
                      await client.call('models.delete', {
                        id: model.id,
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
        <ModelEditor
          key={editor.model?.id ?? 'new'}
          model={editor.model}
          onClose={() => setEditor(undefined)}
        />
      )}
    </Panel>
  );
};
