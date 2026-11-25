import { Loader, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import { t } from '@/i18n/index.ts';
import { ErrorNotice } from './error-notice.tsx';

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
