import { t } from '../../i18n/index.ts';
import { Select } from '@mantine/core';
import { ArrowUpRight, Target } from 'lucide-react';
import { isTerminal, type Run } from '../../model';
import { compactKey, localDate } from '../../ui/format';
import { RunStatusBadge } from './RunStatusBadge';

export function RunContext({
  run,
  runs,
  runIndex,
  cursor,
  onSelectRun,
  onViewPlan,
}: {
  run: Run;
  runs: Run[];
  runIndex: number;
  cursor: number;
  onSelectRun: (index: number) => void;
  onViewPlan: () => void;
}) {
  return (
    <div className="run-context">
      <div className="context-icon">
        <Target size={17} />
      </div>
      <div className="context-text">
        <span className="micro">
          {t('OFFICE CONTEXT')} <span>· {isTerminal(run) ? t('RUN RECORDING') : t('LIVE')}</span>
        </span>
        <button onClick={onViewPlan}>
          <span className="mono muted">{compactKey(run.key)}</span> {run.title}
          <ArrowUpRight size={13} />
        </button>
      </div>
      <Select
        aria-label={t('Select run recording')}
        value={String(runIndex)}
        onChange={(v) => v !== null && onSelectRun(Number(v))}
        data={runs.map((r, i) => ({
          value: String(i),
          label: `${compactKey(r.key)} · ${localDate(r.createdAt).slice(0, 5)}`,
        }))}
        className="run-select"
        size="xs"
        allowDeselect={false}
      />
      <RunStatusBadge run={run} cursor={cursor} className="phase-badge" />
    </div>
  );
}
