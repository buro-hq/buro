import { getFormattingLocale, t } from '../i18n/index.ts';
export const statusLabel = {
  get waiting() {
    return t('Waiting');
  },
  get working() {
    return t('Working');
  },
  get done() {
    return t('Completed');
  },
};
export const localDate = (value: string) =>
  new Date(value).toLocaleTimeString(getFormattingLocale(), {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
export function shortCommand(command: string) {
  const normalized = command.trim();
  if (normalized.includes('node --check')) return t('Syntax check');
  if (/\brg\b/.test(normalized)) return t('Search project files');
  return normalized.length > 84 ? normalized.slice(0, 81) + '…' : normalized;
}

export const compactKey = (key: string) => (key.length > 20 ? key.slice(0, 10) : key);
