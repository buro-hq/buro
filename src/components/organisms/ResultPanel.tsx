import { t } from '../../i18n/index.ts';
import { ArrowDownToLine, CheckCheck, CircleAlert, ShieldCheck } from 'lucide-react';
import { getRunViewState } from '../../features/runs/view-model';
import { type Run } from '../../model';
import { ApplyRunResult } from './ApplyRunResult';
import { RunRecoveryPanel } from './RunRecoveryPanel';
import { RunResultActions } from './RunResultActions';

export function ResultPanel({ run, cursor }: { run: Run; cursor: number }) {
  const { complete, currentPhase } = getRunViewState(run, cursor);
  const runIndex = Math.max(0, Number(run.key.match(/(\d+)$/)?.[1] || 1) - 1);
  const failed = complete && !!run.status && run.status !== 'completed';
  return (
    <div className="content-panel">
      <div className={`result-icon ${failed ? 'result-failed' : ''}`}>
        {failed ? <CircleAlert size={26} /> : <CheckCheck size={26} />}
      </div>
      <h2>
        {complete
          ? run.status && run.status !== 'completed'
            ? currentPhase
            : t('Implementation ready')
          : t('Work in progress')}
      </h2>
      <p className="caption">
        {complete
          ? run.status && run.status !== 'completed'
            ? t('The run ended without acceptance.')
            : t('Implementation, tests and independent review are complete.')
          : t('The result will appear after checks and review.')}
      </p>
      {complete && (
        <>
          {run.repairEnvironment && (
            <p className="caption">
              {t('Environment repair allowed · dependencies are isolated from the source project')}
            </p>
          )}
          <pre className="result-text">{run.result}</pre>
          <RunRecoveryPanel run={run} />
          <RunResultActions run={run} />
          <ApplyRunResult run={run} />
          {run.workspace && (
            <p className="source-path">
              Worktree: {run.workspace}
              <br />
              Commit: {run.commit || t('Not accepted')}
            </p>
          )}
          <div className="result-receipt">
            <ShieldCheck size={17} />
            <span>
              {run.scopePreserved
                ? t('Change boundaries respected.')
                : t('Change boundaries were violated.')}{' '}
              {run.review
                ? t('Review: {p0}', { p0: run.review.verdict })
                : run.independentReviewer
                  ? t('Independent review completed.')
                  : t('Independent review is incomplete.')}
            </span>
          </div>
          {!run.goalId && (
            <a href={`/artifacts/${runIndex + 1}-result.md`} download className="text-button">
              <ArrowDownToLine size={14} /> {t('Download report')}
            </a>
          )}
        </>
      )}
    </div>
  );
}
