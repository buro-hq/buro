import type { ReactElement } from 'react';
/** The colors rendered by this component, independent of application theme implementations. */
export interface ThemePreviewColors {
  bg: string;
  sidebar: string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
}
/** Shows a preset preview using its actual palette. */
export const ThemePreview = ({ colors }: { colors: ThemePreviewColors }): ReactElement => (
  <svg className="theme-preview" viewBox="0 0 72 64" aria-hidden="true">
    <rect width="72" height="64" rx="7" fill={colors.bg} />
    <path d="M7 0h10v64H7a7 7 0 0 1-7-7V7a7 7 0 0 1 7-7" fill={colors.sidebar} />
    <rect x="5" y="8" width="7" height="6" rx="2" fill={colors.accent} />
    <rect x="5" y="20" width="8" height="2" rx="1" fill={colors.line} />
    <rect x="5" y="26" width="8" height="2" rx="1" fill={colors.line} />
    <rect x="23" y="9" width="30" height="3" rx="1" fill={colors.text} />
    <rect x="23" y="19" width="42" height="34" rx="4" fill={colors.panel} stroke={colors.line} />
    <rect x="29" y="27" width="21" height="3" rx="1" fill={colors.muted} />
    <rect x="29" y="35" width="30" height="2" rx="1" fill={colors.line} />
    <rect x="29" y="42" width="17" height="5" rx="2" fill={colors.accent} />
  </svg>
);
