import { Button, Checkbox, Collapse, Group, Select, Stack, Textarea } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { LaunchOptions, ReviewSettings } from '#shared/contracts';
import type { AvailableModel } from '../../../../agent/contracts/model.ts';
import { ReviewEditor } from './review-editor.tsx';
import { t } from '@/i18n/index.ts';

/** Controlled overrides shared by preset management and the goal launch form. */
export interface LaunchOptionsEditorProps {
  value: LaunchOptions;
  models: AvailableModel[];
  reviewDefaults?: ReviewSettings;
  collapsible?: boolean;
  onChange(value: LaunchOptions): void;
}

/** Keeps omitted values distinct from explicit empty instructions and disabled review. */
export const LaunchOptionsEditor = (input: LaunchOptionsEditorProps): ReactElement => {
  const { value, models, reviewDefaults, collapsible, onChange } = input;
  const [expanded, setExpanded] = useState(!collapsible);
  const change = <K extends keyof LaunchOptions,>(input: { key: K; setting: LaunchOptions[K] }): void => {
    const { key, setting } = input;
    const next = { ...value, [key]: setting };
    if (setting === undefined)
      delete next[key];

    onChange(next);
  };
  const choices = models.map((model) => ({ value: model.id, label: model.name ?? model.id }));
  const { modelId } = value;
  const hasOverride = modelId !== undefined;
  const isAvailable = models.some((model) => model.id === modelId);
  if (hasOverride && !isAvailable)
    choices.push({
      value: modelId,
      label: modelId,
    });

  return (
    <Stack>
      <Group>
        <Select
          label={t('Model')}
          placeholder={t('Application default')}
          clearable
          value={modelId ?? null}
          onChange={(modelId) => change({
            key: 'modelId',
            setting: modelId ?? undefined,
          })}
          data={choices}
          miw={240}
        />
        {collapsible && (
          <Button variant="subtle" mt="auto" onClick={() => setExpanded((current) => !current)}>
            {t('Run options')}
          </Button>
        )}
      </Group>
      <Collapse in={expanded}>
        <Stack>
          <Checkbox
            label={t('Override instructions')}
            checked={value.instructions !== undefined}
            onChange={(event) => change({
              key: 'instructions',
              setting: event.currentTarget.checked ? '' : undefined,
            })}
          />
          <Textarea
            label={t('Instructions override')}
            description={t('Enable the override to use empty instructions instead of application defaults.')}
            value={value.instructions ?? ''}
            onChange={(event) => change({
              key: 'instructions',
              setting: event.currentTarget.value,
            })}
            autosize
            minRows={3}
          />
          <Select
            label={t('Automatic team review')}
            placeholder={t('Application default')}
            clearable
            value={value.review?.enabled === undefined ? null : value.review.enabled ? 'enabled' : 'disabled'}
            onChange={(mode) => {
              const review = { ...value.review };
              if (mode === null)
                delete review.enabled;
              else
                review.enabled = mode === 'enabled';

              change({
                key: 'review',
                setting: Object.keys(review).length ? review : undefined,
              });
            }}
            data={[
              { value: 'enabled', label: t('Enabled') },
              { value: 'disabled', label: t('Disabled') },
            ]}
          />
          {value.review !== undefined
            ? (
                <>
                  <ReviewEditor
                    value={value.review}
                    defaults={reviewDefaults}
                    models={models}
                    onChange={(review) => change({
                      key: 'review',
                      setting: review,
                    })}
                  />
                  <Button
                    variant="subtle"
                    onClick={() => change({
                      key: 'review',
                      setting: undefined,
                    })}
                  >
                    {t('Use default review settings')}
                  </Button>
                </>
              )
            : (
                <Button
                  variant="default"
                  onClick={() => change({
                    key: 'review',
                    setting: {},
                  })}
                >
                  {t('Customize review settings')}
                </Button>
              )}
        </Stack>
      </Collapse>
    </Stack>
  );
};
