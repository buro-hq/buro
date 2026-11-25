import { Alert } from '@mantine/core';
import type { ReactElement } from 'react';
import { t } from '@/i18n/index.ts';

/** Displays concrete action or query feedback without adding an approval step. */
export const ErrorNotice = (input: { error?: string }): ReactElement | null => {
  const { error } = input;
  if (!error)
    return null;

  return <Alert color="red" role="alert">{t(error)}</Alert>;
};
