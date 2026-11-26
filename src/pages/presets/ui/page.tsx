import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { LaunchPreset } from '#shared/contracts';
import { useApplication, useApiQuery } from '@/data/application.tsx';
import { Panel, ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';
import { t } from '@/i18n/index.ts';
import { PresetEditor } from '@/features/presets';

/** Manages reusable launch data independently of projects and application defaults. */
export const PresetsPage = (): ReactElement => {
  const { client } = useApplication();
  const presets = useApiQuery('presets.list', {});
  const action = useOperation();
  const [editor, setEditor] = useState<{ preset?: LaunchPreset }>();
  return (
    <Panel
      title={t('Launch presets')}
      description={t('Save launch settings, then copy and adjust them when starting a goal.')}
      aside={<Button onClick={() => setEditor({})}>{t('New launch preset')}</Button>}
    >
      <Stack>
        <QueryFeedback loading={presets.loading} error={presets.error} />
        <ErrorNotice error={action.error} />
        {presets.data?.length === 0 && <Text c="dimmed">{t('No launch presets yet')}</Text>}
        {presets.data?.map((preset) => (
          <Paper key={preset.id} withBorder p="md">
            <Stack>
              <Text fw={600}>{preset.name}</Text>
              <Group>
                <Button
                  variant="default"
                  onClick={() => setEditor({
                    preset,
                  })}
                >{t('Edit')}
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  loading={action.busy}
                  onClick={() => void action.perform(async () => {
                    await client.call('presets.delete', {
                      id: preset.id,
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
        <PresetEditor
          key={editor.preset?.id ?? 'new'}
          preset={editor.preset}
          onClose={() => setEditor(undefined)}
        />
      )}
    </Panel>
  );
};
