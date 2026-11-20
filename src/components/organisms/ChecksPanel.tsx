import { t } from '../../i18n/index.ts';
import { ChevronRight, Circle, CircleCheck, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import { getCheckViewState, type CheckState } from '../../features/runs/check-state.ts';
import { clock, counts, owner, seconds, type Milestone, type Run } from '../../model';

function stateLabel(state: CheckState, review = false) {
  switch (state) {
    case 'passed':
      return t('All checks passed');
    case 'reviewed':
      return t('Review approved');
    case 'failed':
      return review ? t('Changes requested') : t('Some checks failed');
    case 'unavailable':
      return t('Evidence unavailable');
    case 'running':
      return review ? t('Review running') : t('Checks running');
    case 'pending':
      return t('awaiting checks');
    default:
      return review ? t('Not reviewed') : t('Not run yet');
  }
}
function EvidenceIcon({ state }: { state: CheckState }) {
  return state === 'passed' || state === 'reviewed' ? (
    <CircleCheck size={16} className="green-text" />
  ) : state === 'failed' ? (
    <X size={16} className="orange-text" />
  ) : (
    <Circle size={16} className="muted" />
  );
}
export function ChecksPanel({
  run,
  cursor,
  onInspect: inspect,
}: {
  run: Run;
  cursor: number;
  onInspect: (event: Milestone) => void;
}) {
  const view = getCheckViewState(run, cursor);
  const test = view.commands.at(-1);
  const testCounts = counts(test?.command.output);
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Result acceptance')}</h2>
          <p className="caption">{t('Agent tests and independent checks are shown separately')}</p>
        </div>
        <ShieldCheck
          size={22}
          className={view.overall === 'reviewed' ? 'green-text' : 'muted'}
          aria-label={stateLabel(view.overall)}
        />
      </div>
      <div className="check-summary">
        <div>
          <span>{t('PROJECT TESTS')}</span>
          <b>
            {test && test.state !== 'running' && testCounts.total > 0
              ? `${testCounts.passed}/${testCounts.total}`
              : '—'}
          </b>
          <small>{stateLabel(view.project)}</small>
        </div>
        <div>
          <span>{t('EXTERNAL ACCEPTANCE')}</span>
          <b>{view.rows.length ? `${view.passed}/${view.total}` : '—'}</b>
          <small>{stateLabel(view.acceptance)}</small>
        </div>
        <div>
          <span>{t('INDEPENDENT REVIEW')}</span>
          <b>
            <EvidenceIcon state={view.review} />
          </b>
          <small>{stateLabel(view.review, true)}</small>
        </div>
      </div>
      {view.commands
        .filter((item) => item.state !== 'running')
        .map(({ command: c, state }) => (
          <button
            key={c.id}
            className={`test-attempt ${state === 'failed' ? 'failed' : ''}`}
            style={{ minHeight: 44 }}
            onClick={() =>
              inspect({
                event: { at: c.completedAt!, type: 'command.completed', threadId: c.threadId },
                actor: owner(run, c.threadId),
                kind: 'test',
                title: t('Test run result'),
                detail: c.command,
                command: c,
                failed: state === 'failed',
              })
            }
          >
            <SquareTerminal size={16} />
            <span>{c.command}</span>
            <b>{stateLabel(state)}</b>
            <span className="mono muted">+{clock(seconds(run.createdAt, c.completedAt!))}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      <h3 className="checks-list-title">
        {t('Independent criteria')} <span>{stateLabel(view.acceptance)}</span>
      </h3>
      <div className="check-list">
        {view.rows.map(({ check: c, state }) => (
          <div key={c.name}>
            <EvidenceIcon state={state} />
            <span title={c.error}>
              {c.name}
              {c.error && <small className="orange-text"> · {c.error}</small>}
            </span>
            <span className="micro muted">
              {state === 'passed'
                ? 'PASS'
                : state === 'failed'
                  ? 'FAIL'
                  : t('Evidence unavailable')}
            </span>
          </div>
        ))}
        {!view.rows.length && (
          <p className="caption">
            {t('No independent check results are available at this point.')}
          </p>
        )}
      </div>
      {view.rows
        .filter(({ check }) => check.command)
        .map(({ check: c, state }) => (
          <details className="spec-details check-command-output" key={c.name}>
            <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 8 }}>
              <EvidenceIcon state={state} />
              {c.name} · {stateLabel(state)}
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
