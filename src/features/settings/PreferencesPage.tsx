import {
  Button,
  Checkbox,
  Collapse,
  Select,
  Stack,
  Textarea,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { t, useLocale, setLocale } from '../../i18n/index.ts';
import { ThemePreview, Panel, ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useAppearance } from '../../theme/AppearanceProvider.tsx';
import { themePresets } from '../../theme/presets.ts';
import { useOperation } from '@/shared/lib';
import { ReviewEditor } from '@/entities/run';
import type { ReviewSettings } from '#shared/contracts';

const ReviewSettingsEditor = (input: { review: ReviewSettings }): ReactElement => {
  const { client } = useApplication();
  const models = useApiQuery('models.list', {});
  const action = useOperation();
  const [review, setReview] = useState(input.review);
  return (
    <Stack>
      <Checkbox
        label={t('Automatically review and correct runs')}
        checked={review.enabled ?? false}
        onChange={(event) => setReview({
          ...review,
          enabled: event.currentTarget.checked,
        })}
      />
      <Collapse in={review.enabled === true}>
        <ReviewEditor value={review} models={models.data ?? []} onChange={setReview} />
      </Collapse>
      <ErrorNotice error={action.error} />
      <Button
        loading={action.busy}
        onClick={() => void action.perform(async () => {
          await client.call('settings.update', {
            review,
          });
          return { ok: true };
        })}
      >
        {t('Save review settings')}
      </Button>
    </Stack>
  );
};

const InstructionsEditor = (input: { instructions: string }): ReactElement => {
  const { client } = useApplication();
  const action = useOperation();
  const [instructions, setInstructions] = useState(input.instructions);
  return (
    <Stack>
      <Textarea
        label={t('Default instructions for new runs')}
        value={instructions}
        onChange={(event) => setInstructions(event.currentTarget.value)}
        autosize
        minRows={7}
      />
      <ErrorNotice error={action.error} />
      <Button
        loading={action.busy}
        onClick={() =>
          void action.perform(async () => {
            await client.call('settings.update', {
              instructions,
            });
            return { ok: true };
          })}
      >
        {t('Save instructions')}
      </Button>
    </Stack>
  );
};

/** Application defaults and local appearance preferences remain independent of projects. */
export const PreferencesPage = (): ReactElement => {
  const settings = useApiQuery('settings.get', {});
  const locale = useLocale();
  const { themeId, setThemeId } = useAppearance();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light');
  const schemes = [
    { id: 'light', label: t('Light'), icon: Sun },
    { id: 'dark', label: t('Dark'), icon: Moon },
    { id: 'auto', label: t('System'), icon: Monitor },
  ] as const;
  return (
    <Panel title={t('Settings')}>
      <Stack gap="xl">
        <section>
          <QueryFeedback loading={settings.loading} error={settings.error} />
          {settings.data && <InstructionsEditor instructions={settings.data.instructions} />}
        </section>
        <section>
          <h3>{t('Automatic team review')}</h3>
          {settings.data?.review && (
            <ReviewSettingsEditor
              key={JSON.stringify(settings.data.review)}
              review={settings.data.review}
            />
          )}
        </section>
        <section className="appearance-section">
          <h3>{t('Language')}</h3>
          <Select
            label={t('Interface language')}
            value={locale}
            allowDeselect={false}
            data={[
              { value: 'en', label: 'English' },
              { value: 'ru', label: t('Russian') },
            ]}
            onChange={(value) => setLocale(value === 'ru' ? 'ru' : 'en')}
          />
        </section>
        <section className="appearance-section">
          <h3>{t('Color scheme')}</h3>
          <div className="scheme-options" role="group" aria-label={t('Color scheme')}>
            {schemes.map((scheme) => (
              <button
                key={scheme.id}
                className={`scheme-option ${colorScheme === scheme.id ? 'selected' : ''}`}
                aria-pressed={colorScheme === scheme.id}
                onClick={() => setColorScheme(scheme.id)}
              >
                <scheme.icon size={17} />
                {scheme.label}
                {colorScheme === scheme.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </section>
        <section className="appearance-section">
          <h3>{t('Theme')}</h3>
          <div className="theme-options" role="group" aria-label={t('Interface theme')}>
            {themePresets.map((preset) => (
              <button
                key={preset.id}
                className={`theme-option ${themeId === preset.id ? 'selected' : ''}`}
                aria-pressed={themeId === preset.id}
                aria-label={preset.name}
                onClick={() => setThemeId(preset.id)}
              >
                <ThemePreview colors={preset[computed]} />
                <span>
                  <b>{preset.name}</b>
                  <small>{preset.description}</small>
                </span>
                {themeId === preset.id && <Check size={15} className="theme-selected-icon" />}
              </button>
            ))}
          </div>
        </section>
      </Stack>
    </Panel>
  );
};
