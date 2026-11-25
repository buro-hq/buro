import { useSyncExternalStore } from 'react';
import en from './locales/en.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
export type Locale = 'en' | 'ru';
const storageKey = 'buro.locale';
const listeners = new Set<() => void>();
const catalogs: Record<Locale, Record<string, string>> = { en, ru };
function savedLocale(): Locale {
  try {
    return localStorage.getItem(storageKey) === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}
let locale = savedLocale();
export const getLocale = () => locale;
export const getFormattingLocale = () => (locale === 'ru' ? 'ru-RU' : 'en-US');
export function setLocale(value: Locale) {
  if (value !== 'en' && value !== 'ru')
    return;

  locale = value;
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    /* Preferences still work for this session. */
  }
  if (typeof document !== 'undefined')
    document.documentElement.lang = value;

  for (const listener of listeners)
    listener();
}
if (typeof document !== 'undefined')
  document.documentElement.lang = locale;

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey) {
      locale = savedLocale();
      document.documentElement.lang = locale;
      for (const listener of listeners)
        listener();
    }
  });

export function useLocale() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLocale,
    () => 'en' as Locale,
  );
}
/** English message IDs are the fallback. Only product messages go through this function. */
export function t(message: string, values: Record<string, unknown> = {}) {
  const template = catalogs[locale][message] ?? en[message as keyof typeof en] ?? message;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match);
}
