import { Alert, Loader, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { t } from '../../i18n/index.ts';

/** Displays concrete action or query feedback without adding an approval step. */
export const ErrorNotice = (input: { error?: string }): ReactElement | null => {
  const { error } = input;
  if (!error)
    return null;

  return <Alert color="red" role="alert">{t(error)}</Alert>;
};

/** A small read-state indicator that preserves already displayed data. */
export const QueryFeedback = (input: { loading?: boolean; error?: string }): ReactElement => (
  <>
    <ErrorNotice error={input.error} />
    {input.loading && (
      <Text size="xs" c="dimmed">
        <Loader size={12} display="inline-block" mr={6} />
        {t('Loading…')}
      </Text>
    )}
  </>
);
