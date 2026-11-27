import { Badge, Button, Group, Paper, Select, Stack, Tabs, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import type { ChangedFile } from '../../../modules/results/result.ts';
import type { ModelConfigurationView, ModelPricing } from '../../../modules/models/model-configuration.ts';
import type { Run } from '../../../modules/runs/run.ts';
import type { Session } from '../../../modules/sessions/session.ts';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { getFormattingLocale, t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '@/shared/ui';
import { useOperation } from '@/shared/lib';
import { SessionView } from './SessionView.tsx';
import { PreviewsPanel } from './PreviewsPanel.tsx';
import { DeliveriesPanel } from './DeliveriesPanel.tsx';
import { ReviewResults } from '@/features/run-review';

const fileStatusLabels: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  T: 'Type changed',
};

const changedFileStatus = (file: ChangedFile): string =>
  t(fileStatusLabels[file.status] ?? 'Changed');

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60)
    return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const formatNumber = (value: number): string => value.toLocaleString(getFormattingLocale());

const formatCost = (value: number): string => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;

/** A session's cost from user-configured prices; unpriced usage stays unknown, never zero. */
const sessionCost = (session: Session, models: ModelConfigurationView[]): number | undefined => {
  const { usage } = session;
  const pricing: ModelPricing | undefined = models.find((model) => model.id === session.modelId)?.pricing;
  if (!usage || !pricing)
    return undefined;

  const { inputPerMillion, cachedInputPerMillion, outputPerMillion } = pricing;
  if (inputPerMillion === undefined && outputPerMillion === undefined)
    return undefined;

  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);

  return uncached * (inputPerMillion ?? 0) / 1e6 +
    cached * (cachedInputPerMillion ?? inputPerMillion ?? 0) / 1e6 +
    (usage.outputTokens ?? 0) * (outputPerMillion ?? 0) / 1e6;
};

/** Aggregates reported token usage and elapsed time; unreported usage is stated, not zeroed. */
const UsageSummary = (input: {
  run: Run;
  sessions: Session[];
  models: ModelConfigurationView[];
}): ReactElement | null => {
  const { run, sessions, models } = input;
  const reported = sessions.filter((session) => session.usage);
  const inputTokens = reported.reduce((total, session) => total + (session.usage?.inputTokens ?? 0), 0);
  const outputTokens = reported.reduce((total, session) => total + (session.usage?.outputTokens ?? 0), 0);
  const unreported = sessions.length - reported.length;
  const costs = sessions.map((session) => sessionCost(session, models)).filter((cost) => cost !== undefined);
  const cost = costs.length ? costs.reduce((total, entry) => total + entry, 0) : undefined;
  const partialCost = costs.length > 0 && costs.length < reported.length;
  const elapsed = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : undefined;
  if (!reported.length && elapsed === undefined)
    return null;

  return (
    <Group gap="lg">
      {reported.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('Reported tokens')}: {t('Input')} {formatNumber(inputTokens)} · {t('Output')} {formatNumber(outputTokens)}
        </Text>
      )}
      {cost !== undefined && (
        <Text size="xs" c="dimmed">
          {t('Reported cost')}: {formatCost(cost)}
          {partialCost ? ` (${t('partial')})` : ''}
        </Text>
      )}
      {unreported > 0 && (
        <Text size="xs" c="dimmed">
          {t('Conversations without reported usage')}: {unreported}
        </Text>
      )}
      {elapsed !== undefined && (
        <Text size="xs" c="dimmed">
          {t('Elapsed')}: {formatDuration(elapsed)}
        </Text>
      )}
    </Group>
  );
};

const Changes = (input: { runId: string }): ReactElement => {
  const { client } = useApplication();
  const changes = useApiQuery('results.inspect', {
    runId: input.runId,
  });
  const action = useOperation();
  return (
    <Stack>
      <QueryFeedback loading={changes.loading} error={changes.error ?? changes.data?.error} />
      <ErrorNotice error={action.error} />
      {changes.data?.files?.map((file) => (
        <Group key={file.path} gap="sm" role="group" aria-label={file.path}>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{file.path}</Text>
          <Badge variant="light">{changedFileStatus(file)}</Badge>
        </Group>
      ))}
      <pre className="feature-pre feature-patch">{changes.data?.patch}</pre>
      {changes.data?.ok && (
        <Button
          loading={action.busy}
          disabled={!changes.data.files?.length}
          onClick={() =>
            void action.perform(async () => {
              const applied = await client.call('results.apply', {
                runId: input.runId,
                revision: changes.data?.revision,
              });
              return { ok: applied.ok, error: applied.error };
            })}
        >
          {t('Apply changes to project')}
        </Button>
      )}
    </Stack>
  );
};

/** A run owns its workspace and sessions; combining its result stays an explicit user action. */
export const RunDetail = (input: {
  id: string;
  onRun(id: string): void;
  onBack(): void;
}): ReactElement => {
  const { client } = useApplication();
  const run = useApiQuery('runs.get', {
    id: input.id,
  });
  const sessions = useApiQuery('sessions.list', {
    runId: input.id,
  });
  const models = useApiQuery('models.list', {});
  const action = useOperation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>('conversation');
  const selected =
    sessions.data?.find((session) => session.id === sessionId) ??
    sessions.data?.find((session) => session.id === run.data?.sessionId) ??
    sessions.data?.[0];
  return (
    <Stack>
      <Group justify="space-between">
        <Button variant="subtle" onClick={input.onBack}>
          {t('All runs')}
        </Button>
        <Group>
          {run.data && <Badge>{t(run.data.status)}</Badge>}
          <Button
            loading={action.busy}
            variant="default"
            onClick={() =>
              void action.perform(async () => {
                await client.call('runs.cancel', {
                  id: input.id,
                });
                return { ok: true };
              })}
          >
            {t('Stop')}
          </Button>
          <Button
            loading={action.busy}
            onClick={() =>
              void action.perform(async () => {
                const result = await client.call('runs.retry', {
                  id: input.id,
                });
                if (result.run)
                  input.onRun(result.run.id);

                return { ok: result.ok, error: result.error };
              })}
          >
            {t('New attempt with saved work')}
          </Button>
        </Group>
      </Group>
      <QueryFeedback loading={run.loading} error={run.error} />
      <ErrorNotice error={action.error ?? run.data?.error} />
      {run.data && (
        <Paper withBorder p="md">
          <Text size="xs" c="dimmed">
            {run.data.id}
          </Text>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {run.data.workspace}
          </Text>
          {sessions.data && <UsageSummary run={run.data} sessions={sessions.data} models={models.data ?? []} />}
          {run.data.result && <pre className="feature-pre">{run.data.result}</pre>}
        </Paper>
      )}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="conversation">{t('Conversations')}</Tabs.Tab>
          <Tabs.Tab value="changes">{t('Changes')}</Tabs.Tab>
          {run.data?.review && <Tabs.Tab value="review">{t('Automatic review')}</Tabs.Tab>}
          <Tabs.Tab value="preview">{t('Preview')}</Tabs.Tab>
          <Tabs.Tab value="publish">{t('Publish')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="conversation" pt="md">
          <Stack>
            <QueryFeedback loading={sessions.loading} error={sessions.error} />
            <Select
              label={t('Session')}
              value={selected?.id ?? null}
              onChange={setSessionId}
              renderOption={({ option }) => {
                const session = sessions.data?.find((item) => item.id === option.value);
                return (
                  <Group justify="space-between" w="100%">
                    <Text size="sm">{option.label}</Text>
                    {session && <Badge variant="light">{t(session.status)}</Badge>}
                  </Group>
                );
              }}
              data={
                sessions.data?.map((session) => ({
                  value: session.id,
                  label: `${session.parentId ? t('Collaborator') : t('Main conversation')} (${session.id.slice(0, 8)})`,
                })) ?? []
              }
            />
            {selected && <SessionView key={selected.id} session={selected} />}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="changes" pt="md">
          {tab === 'changes' && <Changes runId={input.id} />}
        </Tabs.Panel>
        <Tabs.Panel value="review" pt="md">
          {run.data?.review && (
            <ReviewResults
              review={run.data.review}
              onSession={(id) => {
                setSessionId(id);
                setTab('conversation');
              }}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="preview" pt="md">
          {tab === 'preview' && <PreviewsPanel runId={input.id} />}
        </Tabs.Panel>
        <Tabs.Panel value="publish" pt="md">
          {tab === 'publish' && <DeliveriesPanel runId={input.id} />}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
};
