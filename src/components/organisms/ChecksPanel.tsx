import { t } from '../../i18n/index.ts';
import { ChevronRight, Circle, CircleCheck, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import { getRunViewState } from '../../features/runs/view-model';
import { clock, counts, isTest, owner, seconds, type Milestone, type Run } from '../../model';

export function ChecksPanel({
  run,
  cursor,
  onInspect: inspect,
}: {
  run: Run;
  cursor: number;
  onInspect: (event: Milestone) => void;
}) {
  const { complete, test, testCounts } = getRunViewState(run, cursor);
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Result acceptance')}</h2>
          <p className="caption">{t('Agent tests and independent checks are shown separately')}</p>
        </div>
        <ShieldCheck size={22} className="green-text" />
      </div>
      <div className="check-summary">
        <div>
          <span>{t('PROJECT TESTS')}</span>
          <b>{test ? `${testCounts.passed}/${testCounts.total}` : '—'}</b>
          <small>
            {testCounts.failed
              ? t('{p0} failed', { p0: testCounts.failed })
              : test
                ? t('Passed at this point')
                : t('Not run yet')}
          </small>
        </div>
        <div>
          <span>{t('EXTERNAL ACCEPTANCE')}</span>
          <b>{complete ? `${run.acceptance.passed}/${run.acceptance.total}` : '—'}</b>
          <small>
            {complete
              ? run.acceptance.total && run.acceptance.passed === run.acceptance.total
                ? t('All checks passed')
                : t('Some checks failed')
              : t('After implementation and review')}
          </small>
        </div>
        <div>
          <span>{t('INDEPENDENT REVIEW')}</span>
          <b>
            <ShieldCheck size={26} />
          </b>
          <small>
            {complete
              ? run.review?.verdict === 'changes_requested'
                ? t('Changes requested')
                : run.independentReviewer
                  ? t('Review completed')
                  : t('Not reviewed')
              : t('Waiting for completion')}
          </small>
        </div>
      </div>
      {run.commands
        .filter(
          (c) => isTest(c) && c.completedAt && seconds(run.createdAt, c.completedAt) <= cursor,
        )
        .map((c) => (
          <button
            key={c.id}
            className={`test-attempt ${c.exitCode ? 'failed' : ''}`}
            onClick={() =>
              inspect({
                event: { at: c.completedAt!, type: 'command.completed', threadId: c.threadId },
                actor: owner(run, c.threadId),
                kind: 'test',
                title: t('Test run result'),
                detail: c.command,
                command: c,
                failed: !!c.exitCode,
              })
            }
          >
            <SquareTerminal size={16} />
            <span>{c.command}</span>
            <b>
              {counts(c.output).passed}/{counts(c.output).total}
            </b>
            <span className="mono muted">+{clock(seconds(run.createdAt, c.completedAt!))}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      <h3 className="checks-list-title">
        {t('Independent criteria')}{' '}
        <span>
          {complete
            ? run.acceptance.total && run.acceptance.passed === run.acceptance.total
              ? t('accepted')
              : t('failed')
            : t('awaiting checks')}
        </span>
      </h3>
      <div className="check-list">
        {run.acceptance.results.map((c) => (
          <div key={c.name}>
            {complete ? (
              c.passed ? (
                <CircleCheck size={16} className="green-text" />
              ) : (
                <X size={16} className="orange-text" />
              )
            ) : (
              <Circle size={16} className="muted" />
            )}
            <span title={c.error}>
              {c.name}
              {c.error && complete && <small className="orange-text"> · {c.error}</small>}
            </span>
            <span className="micro muted">
              {complete ? (c.passed ? 'PASS' : 'FAIL') : 'PENDING'}
            </span>
          </div>
        ))}
      </div>
      {run.acceptance.results
        .filter((c) => c.command)
        .map((c) => (
          <details className="spec-details check-command-output" key={c.name}>
            <summary>
              {c.passed ? '✓' : '×'} {c.name}
            </summary>
            <pre className="terminal">
              {c.command}
              {'\n'}
              {c.output || c.error || ''}
            </pre>
          </details>
        ))}
    </div>
  );
}
