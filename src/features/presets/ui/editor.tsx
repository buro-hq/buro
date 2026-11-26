import { Button, Modal, Stack, TextInput } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { LaunchOptions, LaunchPreset } from '#shared/contracts';
import { useApplication, useApiQuery } from '@/data/application.tsx';
import { LaunchOptionsEditor } from '@/entities/run';
import { ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';
import { t } from '@/i18n/index.ts';

/** A saved preset or a new draft, with a callback for closing its editor. */
export interface PresetEditorProps {
  preset?: LaunchPreset;
  onClose(): void;
}

/** Edits a detached draft and closes only after a successful save. */
export const PresetEditor = ({ preset, onClose }: PresetEditorProps): ReactElement => {
  const { client } = useApplication();
  const models = useApiQuery('models.list', {});
  const action = useOperation();
  const [name, setName] = useState(preset?.name ?? '');
  const [options, setOptions] = useState<LaunchOptions>(() => structuredClone(preset?.options ?? {}));
  const save = async (): Promise<void> => {
    const result = await action.perform(async () => {
      const saved = await client.call('presets.save', {
        ...(preset ? { id: preset.id } : {}),
        name,
        options,
      });
      return { ok: saved.ok, error: saved.error };
    });
    if (result.ok)
      onClose();
  };
  return (
    <Modal opened onClose={onClose} title={t(preset ? 'Edit launch preset' : 'New launch preset')} size="lg">
      <form onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      >
        <Stack>
          <TextInput
            label={t('Preset name')}
            required
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <QueryFeedback loading={models.loading} error={models.error} />
          <LaunchOptionsEditor value={options} models={models.data ?? []} onChange={setOptions} />
          <ErrorNotice error={action.error} />
          <Button type="submit" loading={action.busy} disabled={!name.trim()}>{t('Save preset')}</Button>
        </Stack>
      </form>
    </Modal>
  );
};
