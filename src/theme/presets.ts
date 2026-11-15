import { t } from '../i18n/index.ts';
export type ThemeColors = {
  bg: string;
  sidebar: string;
  panel: string;
  hover: string;
  line: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  accentText: string;
};
export type ThemePreset = {
  id: string;
  name: string;
  description: string;
  dark: ThemeColors;
  light: ThemeColors;
};
export const defaultThemeId = 'cobalt';
export const themePresets: ThemePreset[] = [
  {
    id: 'sage',
    get name() {
      return t('Sage');
    },
    get description() {
      return t('Warm green accent');
    },
    dark: {
      bg: '#14191a',
      sidebar: '#101516',
      panel: '#1b2222',
      hover: '#252e2c',
      line: '#35413d',
      text: '#e8eee7',
      muted: '#a5b2aa',
      subtle: '#81948a',
      accent: '#bad3a2',
      accentText: '#c5deb0',
    },
    light: {
      bg: '#f3f6f1',
      sidebar: '#e9eee5',
      panel: '#ffffff',
      hover: '#eaf0e6',
      line: '#d3ddd0',
      text: '#202c22',
      muted: '#566b58',
      subtle: '#657b68',
      accent: '#496d35',
      accentText: '#3f632c',
    },
  },
  {
    id: 'graphite',
    get name() {
      return t('Graphite');
    },
    get description() {
      return t('Calm neutral palette');
    },
    dark: {
      bg: '#15181d',
      sidebar: '#101318',
      panel: '#1d222a',
      hover: '#282f39',
      line: '#37414e',
      text: '#e7edf5',
      muted: '#a5b1c2',
      subtle: '#8393aa',
      accent: '#becddd',
      accentText: '#d0dcec',
    },
    light: {
      bg: '#f2f5f8',
      sidebar: '#e8edf3',
      panel: '#ffffff',
      hover: '#e9eff5',
      line: '#d2dce7',
      text: '#202c3b',
      muted: '#53677d',
      subtle: '#687c92',
      accent: '#4b6582',
      accentText: '#3c5775',
    },
  },
  {
    id: 'ocean',
    get name() {
      return t('Ocean');
    },
    get description() {
      return t('Cool blue shades');
    },
    dark: {
      bg: '#111b22',
      sidebar: '#0e161d',
      panel: '#192731',
      hover: '#243540',
      line: '#354b58',
      text: '#e1edf5',
      muted: '#9eb7c6',
      subtle: '#7d9baa',
      accent: '#99cddd',
      accentText: '#b1deeb',
    },
    light: {
      bg: '#f1f7fa',
      sidebar: '#e4eff5',
      panel: '#ffffff',
      hover: '#e5f1f7',
      line: '#cbdfe9',
      text: '#193544',
      muted: '#4b6c7f',
      subtle: '#5f7f90',
      accent: '#286d87',
      accentText: '#1d607a',
    },
  },
  {
    id: 'iris',
    get name() {
      return t('Iris');
    },
    get description() {
      return t('Soft purple accent');
    },
    dark: {
      bg: '#1a1720',
      sidebar: '#14121a',
      panel: '#24212d',
      hover: '#302c3b',
      line: '#443d53',
      text: '#ede7f5',
      muted: '#b5a9c4',
      subtle: '#9888ac',
      accent: '#c6b5e8',
      accentText: '#d6c6f3',
    },
    light: {
      bg: '#f7f4fb',
      sidebar: '#eee8f5',
      panel: '#ffffff',
      hover: '#eee8f6',
      line: '#ddd1ea',
      text: '#30243f',
      muted: '#705d83',
      subtle: '#7c6a8e',
      accent: '#755199',
      accentText: '#654188',
    },
  },
  {
    id: 'cobalt',
    get name() {
      return t('Cobalt');
    },
    get description() {
      return t('Cobalt blue accent');
    },
    dark: {
      bg: '#131a2b',
      sidebar: '#0f1423',
      panel: '#1b2540',
      hover: '#243153',
      line: '#354568',
      text: '#e7edff',
      muted: '#a6b3d2',
      subtle: '#8497bb',
      accent: '#a6bbff',
      accentText: '#c4d1ff',
    },
    light: {
      bg: '#f2f5ff',
      sidebar: '#e7edfc',
      panel: '#ffffff',
      hover: '#e7edfc',
      line: '#cdd7ef',
      text: '#233357',
      muted: '#52678e',
      subtle: '#687da3',
      accent: '#3e60b4',
      accentText: '#34549f',
    },
  },
];
export const getThemePreset = (id: string) =>
  themePresets.find((theme) => theme.id === id) ||
  themePresets.find((theme) => theme.id === defaultThemeId)!;
