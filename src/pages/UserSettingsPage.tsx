import { useLocale, setLocale, t } from '../i18n/index.ts';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../protocol/domain.ts';
import { Select, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { ThemePreview } from '../components/atoms/ThemePreview';
import { Panel } from '../components/molecules/Panel';
import { useAppearance } from '../theme/AppearanceProvider';
import { themePresets } from '../theme/presets';
import { ExecutionResources } from '../components/organisms/ExecutionResources';
export function UserSettingsPage() {
  const locale = useLocale();
  const { themeId, setThemeId } = useAppearance(),
    { colorScheme, setColorScheme } = useMantineColorScheme(),
    computed = useComputedColorScheme('dark');
  const schemes = [
    { id: 'light', label: t('Light'), icon: Sun },
    { id: 'dark', label: t('Dark'), icon: Moon },
    { id: 'auto', label: t('System'), icon: Monitor },
  ] as const;
  return (
    <Panel
      title={t('User settings')}
      description={t('Execution resources and interface preferences.')}
    >
      <ExecutionResources />
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
          description={t('Saved in this browser. Project content keeps its original language.')}
        />
      </section>
      <section className="appearance-section">
        <h3>{t('Color scheme')}</h3>
        <div className="scheme-options" role="group" aria-label={t('Color scheme')}>
          {schemes.map((item) => (
            <button
              key={item.id}
              className={`scheme-option ${colorScheme === item.id ? 'selected' : ''}`}
              aria-pressed={colorScheme === item.id}
              onClick={() => setColorScheme(item.id)}
            >
              <item.icon size={17} />
              {item.label}
              {colorScheme === item.id && <Check size={14} />}
            </button>
          ))}
        </div>
      </section>
      <section className="appearance-section">
        <h3>{t('Theme')}</h3>
        <p className="caption">
          {t('Choose a palette. Previews use the current light or dark color scheme.')}
        </p>
        <div className="theme-options" role="group" aria-label={t('Interface theme')}>
          {themePresets.map((preset) => (
            <button
              key={preset.id}
              className={`theme-option ${themeId === preset.id ? 'selected' : ''}`}
              aria-pressed={themeId === preset.id}
              aria-label={t('Theme {p0}', { p0: preset.name })}
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
      <section className="appearance-section">
        <h3>{t('Goal execution')}</h3>
        <Select
          label={t('Time policy · TODO')}
          disabled
          value="activity"
          data={[{ value: 'activity', label: t('No total limit; stop when progress stalls') }]}
          description={t(
            'Current: stop after {p0} minutes without coordinator or child agent activity. TODO: configure the policy and threshold here.',
            { p0: DEFAULT_IDLE_TIMEOUT_MS / 60000 },
          )}
        />
      </section>
    </Panel>
  );
}
