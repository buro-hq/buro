import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactElement } from 'react';
import type { RunReviewState } from '#shared/contracts';
import { t } from '../../../i18n/index.ts';

const statusLabels: Record<string, string> = {
  pending: 'Review pending',
  running: 'Review running',
  completed: 'Review completed',
  failed: 'Review needs attention',
  interrupted: 'Review interrupted',
  limited: 'Configured review limit reached',
  findings: 'Review findings',
};

/** Shows independent review outcomes alongside actual command receipts. */
export interface ReviewResultsProps {
  review: RunReviewState;
  onSession(sessionId: string): void;
}

/** Review notes are visible evidence; applying a result does not depend on an approval flag. */
export const ReviewResults = ({ review, onSession }: ReviewResultsProps): ReactElement => (
  <Stack>
    <Group>
      <Text fw={600}>{t('Automatic review')}</Text>
      <Badge>{t(statusLabels[review.status] ?? review.status)}</Badge>
    </Group>
    {review.error && <Text c="red">{review.error}</Text>}
    {review.reports.map((report) => (
      <Paper withBorder p="md" key={report.sessionId}>
        <Stack gap="sm">
          <Group>
            <Text fw={600}>{report.name}</Text>
            <Badge variant="light">{t('Round {number}', {
              number: report.round,
            })}
            </Badge>
            <Badge variant="outline">{t(report.status)}</Badge>
          </Group>
          {report.summary && <Text size="sm">{report.summary}</Text>}
          {report.error && <Text size="sm" c="red">{report.error}</Text>}
          {report.findings?.map((finding, index) => (
            <div key={index}>
              {finding.path && (
                <Text size="xs" c="dimmed">
                  {finding.path}{finding.line ? `:${finding.line}` : ''}
                </Text>
              )}
              <Text size="sm">{finding.message}</Text>
            </div>
          ))}
          {report.commands?.length
            ? (
                <details>
                  <summary>{t('Observed commands')}</summary>
                  {report.commands.map((command, index) => (
                    <div key={index}>
                      <pre className="feature-pre">{command.command}</pre>
                      <Text size="xs" c={command.failed ? 'red' : 'dimmed'}>
                        {command.failed ? t('Failed') : t('Finished')}
                        {command.exitCode !== undefined ? ` · ${t('Exit code')}: ${command.exitCode}` : ''}
                      </Text>
                    </div>
                  ))}
                </details>
              )
            : <Text size="xs" c="dimmed">{t('No commands were observed in this review session.')}</Text>}
          <Button variant="subtle" onClick={() => onSession(report.sessionId)}>
            {t('Open review conversation')}
          </Button>
        </Stack>
      </Paper>
    ))}
  </Stack>
);
