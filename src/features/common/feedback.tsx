import { Alert, Loader, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { t } from '../../i18n/index.ts';

/** Displays concrete action or query feedback without adding an approval step. */
export function ErrorNotice(input: { error?: string }): ReactElement | null {
  return input.error ? (
    <Alert color="red" role="alert">
      {t(input.error)}
    </Alert>
  ) : null;
}

/** A small read-state indicator that preserves already displayed data. */
export function QueryFeedback(input: { loading?: boolean; error?: string }): ReactElement {
  return (
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
}
