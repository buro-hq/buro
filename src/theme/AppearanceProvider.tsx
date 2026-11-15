import {
  createTheme,
  localStorageColorSchemeManager,
  MantineProvider,
  type CSSVariablesResolver,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { defaultThemeId, getThemePreset, type ThemeColors } from './presets';
const AppearanceContext = createContext<{ themeId: string; setThemeId: (value: string) => void }>({
  themeId: defaultThemeId,
  setThemeId: () => {},
});
const mix = (color: string, ratio: number) => {
  const n = Number.parseInt(color.slice(1), 16);
  return (
    '#' +
    [n >> 16, (n >> 8) & 255, n & 255]
      .map((c) =>
        Math.round(c + (255 - c) * ratio)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
};
function variables(colors: ThemeColors, scheme: 'light' | 'dark') {
  const dark = scheme === 'dark';
  return {
    '--bg': colors.bg,
    '--sidebar': colors.sidebar,
    '--panel': colors.panel,
    '--panel-hover': colors.hover,
    '--line': colors.line,
    '--line-soft': `color-mix(in srgb, ${colors.line} 65%, ${colors.bg})`,
    '--text': colors.text,
    '--muted': colors.muted,
    '--subtle': colors.subtle,
    '--accent': colors.accent,
    '--accent-text': colors.accentText,
    '--accent-soft': `color-mix(in srgb, ${colors.accent} ${dark ? '12%' : '10%'}, ${colors.panel})`,
    '--on-accent': dark ? '#17201d' : '#ffffff',
    '--orange': dark ? '#e7ba86' : '#936022',
    '--danger': dark ? '#eda79b' : '#b13d33',
    '--success': dark ? '#abd3b5' : '#39784c',
    '--role-implementation': dark ? '#a2d3b2' : '#307246',
    '--role-testing': dark ? '#abbff1' : '#3b62ab',
    '--role-review': dark ? '#d2b9ea' : '#8251aa',
    '--role-coordination': dark ? '#dfc38f' : '#8e661e',
    '--role-general': colors.accentText,
    '--mantine-color-body': colors.bg,
    '--mantine-color-text': colors.text,
    '--mantine-color-default': colors.panel,
    '--mantine-color-default-hover': colors.hover,
    '--mantine-color-default-color': colors.text,
    '--mantine-color-default-border': colors.line,
    '--mantine-color-dimmed': colors.muted,
    '--mantine-color-placeholder': colors.subtle,
    '--mantine-color-error': dark ? '#eda79b' : '#b13d33',
    '--mantine-color-anchor': colors.accentText,
    '--mantine-color-sage-filled': colors.accent,
    '--mantine-color-sage-filled-hover': `color-mix(in srgb, ${colors.accent} 88%, ${dark ? 'white' : 'black'})`,
    '--mantine-color-sage-light': `color-mix(in srgb, ${colors.accent} 13%, transparent)`,
    '--mantine-color-sage-light-hover': `color-mix(in srgb, ${colors.accent} 22%, transparent)`,
    '--mantine-color-sage-light-color': colors.accentText,
    '--mantine-color-sage-outline': colors.accentText,
  };
}
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [savedTheme, setTheme] = useLocalStorage<string>({
      key: 'project-panel-theme',
      defaultValue: defaultThemeId,
    }),
    preset = getThemePreset(savedTheme);
  const theme = useMemo(
    () =>
      createTheme({
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        primaryColor: 'sage',
        primaryShade: { dark: 3, light: 7 },
        autoContrast: true,
        colors: {
          sage: [
            mix(preset.light.accent, 0.94),
            mix(preset.light.accent, 0.85),
            mix(preset.light.accent, 0.7),
            mix(preset.light.accent, 0.55),
            mix(preset.light.accent, 0.4),
            mix(preset.light.accent, 0.25),
            mix(preset.light.accent, 0.1),
            preset.light.accent,
            preset.light.accent,
            preset.light.accent,
          ],
        },
        fontSizes: { xs: '0.6875rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem', xl: '1.125rem' },
        defaultRadius: 'md',
        headings: { fontFamily: 'inherit', fontWeight: '600' },
        components: {
          Button: { defaultProps: { size: 'sm', fw: 500, variant: 'filled' } },
          TextInput: { defaultProps: { size: 'sm' } },
          Textarea: { defaultProps: { size: 'sm' } },
          Select: { defaultProps: { size: 'sm' } },
          MultiSelect: { defaultProps: { size: 'sm' } },
          Tooltip: { defaultProps: { withArrow: true } },
          Modal: { defaultProps: { centered: true, radius: 'md' } },
          Drawer: { defaultProps: { position: 'right' } },
        },
      }),
    [preset],
  );
  const resolver: CSSVariablesResolver = useMemo(
    () => () => ({
      variables: {},
      light: variables(preset.light, 'light'),
      dark: variables(preset.dark, 'dark'),
    }),
    [preset],
  );
  const manager = useMemo(
    () => localStorageColorSchemeManager({ key: 'project-panel-color-scheme' }),
    [],
  );
  return (
    <AppearanceContext.Provider
      value={{ themeId: preset.id, setThemeId: (value) => setTheme(getThemePreset(value).id) }}
    >
      <MantineProvider
        theme={theme}
        cssVariablesResolver={resolver}
        colorSchemeManager={manager}
        defaultColorScheme="dark"
      >
        {children}
      </MantineProvider>
    </AppearanceContext.Provider>
  );
}
export const useAppearance = () => useContext(AppearanceContext);
