import { Group, Stack, Text } from '@mantine/core';
import type { EffectivePolicy } from '../../../protocol/autonomy.ts';
import { t } from '../../i18n/index.ts';
import { operationLabel } from '../../ui/operation-label.ts';

/** The service resolves policy; this component only formats its public projection. */
export function PolicySummary({ policy }: { policy?: EffectivePolicy }) {
  if (!policy) return null;
  const limit = policy.usage.policy;
  const hasLimits =
    limit &&
    [limit.maxRequests, limit.maxReservedOutputTokens, limit.maxToolCalls].some(
      (value) => value !== undefined,
    );
  return (
    <Stack gap={4} my="xs" data-policy-source={policy.source}>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {t('Files')}
        </Text>
        <Text size="xs">
          {policy.files.mode === 'strict'
            ? t('Restricted to planned paths')
            : t('Additional files allowed')}
        </Text>
      </Group>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {t('Models')}
        </Text>
        <Text size="xs">
          {policy.routing.unavailable?.length
            ? t('Model settings need attention')
            : policy.routing.dataPolicy === 'local-only'
              ? t('Local only')
              : policy.routing.dataPolicy === 'hybrid'
                ? t('Hybrid')
                : t('Not configured')}
        </Text>
      </Group>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {t('Checks')}
        </Text>
        <Text size="xs">
          {policy.checks.intermediate !== 'available'
            ? t('Final snapshot checks')
            : t('Service checks and fresh review')}
        </Text>
      </Group>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {t('Managed model usage')}
        </Text>
        <Text size="xs">
          {!limit
            ? t('Usage accounting unavailable')
            : limit.maxRequests !== undefined
              ? t('Up to {p0} requests', { p0: limit.maxRequests })
              : hasLimits
                ? t('User-defined usage limits')
                : t('No task usage limit')}
        </Text>
      </Group>
      <details>
        <summary className="caption">{t('Policy details')}</summary>
        <Stack gap={4} mt={4}>
          <Text size="xs" c="dimmed">
            {policy.source === 'saved-run'
              ? t('Saved run settings')
              : t('Current project settings')}{' '}
            ·{' '}
            {policy.origin.kind === 'project-profile'
              ? t('Project profile v{p0}', { p0: policy.origin.revision })
              : t('Service settings')}
          </Text>
          <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
            {t('Planned paths:')} {policy.files.plannedPaths.join(', ') || t('Automatic discovery')}
          </Text>
          {!!policy.files.protectedPaths.length && (
            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
              {t('Protected paths')}: {policy.files.protectedPaths.join(', ')}
            </Text>
          )}
          {policy.routing.assignments.map((item) => (
            <Text
              key={`${item.operationId || ''}:${item.roleId}`}
              size="xs"
              style={{ overflowWrap: 'anywhere' }}
            >
              {item.operationLabel ? operationLabel(item.operationLabel) + ' · ' : ''}
              {item.roleId}: {item.model || item.runtimeId} · {item.runtimeId}
            </Text>
          ))}
          {policy.routing.unavailable?.map((item) => (
            <Text
              key={`${item.operationId || ''}:${item.roleId}`}
              size="xs"
              c="orange"
              style={{ overflowWrap: 'anywhere' }}
            >
              {item.operationLabel ? operationLabel(item.operationLabel) + ' · ' : ''}
              {item.roleId}: {t(item.message)}
            </Text>
          ))}
          {policy.checks.intermediate === 'deferred' && (
            <Text size="xs" c="dimmed">
              {t(
                'Agent commands and intermediate checks are deferred; final isolated checks and an independent review still run.',
              )}
            </Text>
          )}
          {policy.checks.intermediate === 'unavailable' && (
            <Text size="xs" c="dimmed">
              {t(
                'Intermediate feedback is unavailable for the selected backend. Final snapshot checks and fresh review still run.',
              )}
            </Text>
          )}
          {limit?.maxReservedOutputTokens !== undefined && (
            <Text size="xs" c="dimmed">
              {t('Output reservation limit: {p0} tokens', {
                p0: limit.maxReservedOutputTokens,
              })}
            </Text>
          )}
          {limit?.maxToolCalls !== undefined && (
            <Text size="xs" c="dimmed">
              {t('Tool call limit: {p0}', { p0: limit.maxToolCalls })}
            </Text>
          )}
          {limit && (
            <Text size="xs" c="dimmed">
              {t(
                'Usage is recorded. Individual requests use the configured context, output window and operation timeout.',
              )}
            </Text>
          )}
          {policy.usage.coverage !== 'managed-api' && (
            <Text size="xs" c="dimmed">
              {t('Some usage is unknown; it is not counted as zero.')}
            </Text>
          )}
        </Stack>
      </details>
    </Stack>
  );
}
