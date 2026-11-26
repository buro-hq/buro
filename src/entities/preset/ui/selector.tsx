import { Select, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import type { LaunchOptions } from '#shared/contracts';
import { useApiQuery } from '@/data/application.tsx';
import { QueryFeedback } from '@/shared/ui';
import { t } from '@/i18n/index.ts';

/** A detached selection, ready to copy into editable launch controls. */
export interface PresetSelection {
  id: string | null;
  options: LaunchOptions;
}

/** Controlled preset selection; clearing returns empty launch options. */
export interface PresetSelectorProps {
  value: string | null;
  onChange(selection: PresetSelection): void;
}

/** Selecting copies current data once; list refreshes never rewrite edited launch controls. */
export const PresetSelector = ({ value, onChange }: PresetSelectorProps): ReactElement => {
  const presets = useApiQuery('presets.list', {});
  const choices = (presets.data ?? []).map((preset) => ({ value: preset.id, label: preset.name }));
  const selected = choices.some((preset) => preset.value === value) ? value : null;
  return (
    <Stack gap="xs">
      <Select
        label={t('Launch preset')}
        placeholder={t('No preset')}
        clearable
        clearButtonProps={{
          'aria-label': t('Clear preset'),
          'aria-hidden': false,
          'tabIndex': 0,
        }}
        value={selected}
        disabled={presets.loading && !presets.data}
        data={choices}
        onChange={(id) => {
          const preset = presets.data?.find((record) => record.id === id);
          onChange({
            id,
            options: structuredClone(preset?.options ?? {}),
          });
        }}
      />
      <QueryFeedback loading={presets.loading} error={presets.error} />
      {presets.data?.length === 0 && <Text size="sm" c="dimmed">{t('No launch presets yet')}</Text>}
    </Stack>
  );
};
