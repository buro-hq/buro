import { t } from '../../i18n/index.ts';
import { Badge } from '@mantine/core';
import { duration, phase, type Run } from '../../model';
export function RunStatusBadge({
  run,
  cursor = duration(run),
  className = '',
}: {
  run: Run;
  cursor?: number;
  className?: string;
}) {
  const label = phase(run, cursor),
    failed = [t('Failed'), t('Interrupted'), t('Needs attention')].includes(label),
    success = label === t('Accepted');
  return (
    <Badge
      variant="light"
      color={failed ? 'orange' : success ? 'sage' : 'gray'}
      className={className}
    >
      <span className={`status-dot ${success ? 'done' : ''}`} />
      {label}
    </Badge>
  );
}
