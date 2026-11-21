import { t } from '../../i18n/index.ts';
import { ArrowDownToLine, CheckCheck, CircleAlert, ShieldCheck } from 'lucide-react';
import { getRunViewState } from '../../features/runs/view-model';
import { getCheckViewState } from '../../features/runs/check-state.ts';
import { type Run } from '../../model';
import { ApplyRunResult } from './ApplyRunResult';
import { RunRecoveryPanel } from './RunRecoveryPanel';
import { RunResultActions } from './RunResultActions';

export function ResultPanel({ run, cursor }: { run: Run; cursor: number }) {
  const { complete, currentPhase } = getRunViewState(run, cursor);
  const evidence = getCheckViewState(run, cursor);
  const runIndex = Math.max(0, Number(run.key.match(/(\d+)$/)?.[1] || 1) - 1);
  const terminalFailure = complete && !!run.status && run.status !== 'completed';
  const failed = terminalFailure || (complete && evidence.overall === 'failed');
  const scopeObservation =
    run.scopeObservation &&
    run.scopeObservation.tree === run.verificationEvidence?.tree &&
    run.verificationEvidence.base === run.baseCommit &&
    run.scopeObservation.mode === run.executionPolicySnapshot?.scope.mode &&
    (!run.verificationView || run.verificationView.tree === run.scopeObservation.tree)
      ? run.scopeObservation
      : undefined;
  return (
    <div className="content-panel">
      <div
        className={`result-icon ${failed ? 'result-failed' : ''}`}
        style={
          !evidence.implementationReady && !failed
            ? { color: 'var(--muted)', background: 'transparent' }
            : undefined
        }
      >
        {evidence.implementationReady ? <CheckCheck size={26} /> : <CircleAlert size={26} />}
      </div>
      <h2>
        {complete
          ? terminalFailure
            ? currentPhase
            : evidence.implementationReady
              ? t('Implementation ready')
              : t('Result recorded')
          : t('Work in progress')}
      </h2>
      <p className="caption">
        {complete
          ? terminalFailure
            ? t('The run ended without acceptance.')
            : evidence.implementationReady
              ? t('Implementation, tests and independent review are complete.')
              : t('Acceptance evidence is incomplete. Inspect checks and review.')
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
          {!!scopeObservation?.additionalPaths.length && (
            <details>
              <summary>
                {t('Observed changes beyond the initial plan ({p0})', {
                  p0: scopeObservation.additionalPaths.length,
                })}
              </summary>
              <p className="caption">{t('Confirmed against the checked source revision.')}</p>
              <ul className="caption">
                {scopeObservation.additionalPaths.map((path) => (
                  <li key={path} style={{ overflowWrap: 'anywhere' }}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
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
              {evidence.scope === 'passed'
                ? t('Change boundaries respected.')
                : evidence.scope === 'failed'
                  ? t('Change boundaries were violated.')
                  : t('Evidence unavailable')}{' '}
              {evidence.review === 'reviewed'
                ? t('Review approved')
                : evidence.review === 'failed'
                  ? t('Changes requested')
                  : evidence.review === 'unavailable'
                    ? t('Evidence unavailable')
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
