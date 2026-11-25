import { Badge, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';

/** Preview processes remain optional and independent of the attempt's completion. */
export const PreviewsPanel = (input: { runId: string }): ReactElement => {
  const { client } = useApplication();
  const previews = useApiQuery('previews.list', {
    runId: input.runId,
  });
  const action = useOperation();
  const [command, setCommand] = useState('');
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('Run a foreground server command. PORT and HOST are assigned automatically.')}
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.perform(async () => {
            const result = await client.call('previews.start', {
              runId: input.runId,
              command,
            });
            return { ok: result.ok, error: result.error };
          });
        }}
      >
        <Group align="end">
          <TextInput
            label={t('Preview command')}
            placeholder={'npm run dev -- --host "$HOST" --port "$PORT"'}
            value={command}
            onChange={(event) => setCommand(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button type="submit" loading={action.busy}>
            {t('Start preview')}
          </Button>
        </Group>
      </form>
      <ErrorNotice error={action.error} />
      <QueryFeedback loading={previews.loading} error={previews.error} />
      {previews.data?.map((preview) => (
        <Paper key={preview.id} withBorder p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Group>
                <Badge>{t(preview.status)}</Badge>
                <Text size="xs" c="dimmed">
                  :
                  {preview.port}
                </Text>
              </Group>
              {['starting', 'running'].includes(preview.status) && (
                <Button
                  variant="default"
                  onClick={() =>
                    void action.perform(async () => {
                      await client.call('previews.stop', {
                        id: preview.id,
                      });
                      return { ok: true };
                    })}
                >
                  {t('Stop preview')}
                </Button>
              )}
            </Group>
            <Text size="sm">{preview.command}</Text>
            {preview.url && (
              <Button
                component="a"
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                variant="light"
              >
                {t('Open preview')}
              </Button>
            )}
            <ErrorNotice error={preview.error} />
            <pre className="feature-pre feature-patch">
              {preview.stdout}
              {preview.stderr}
            </pre>
            {preview.truncated && (
              <Text c="dimmed" size="xs">
                {t('Output truncated')}
              </Text>
            )}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
