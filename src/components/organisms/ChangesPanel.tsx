import { t } from '../../i18n/index.ts';
import { Switch } from '@mantine/core';
import { ArrowDownToLine, ArrowRight, FileCode2, History } from 'lucide-react';
import { useState } from 'react';
import { getRunViewState } from '../../features/runs/view-model';
import { diffLines, type Run } from '../../model';
import { EmptyState } from '../molecules/EmptyState';

export function ChangesPanel({
  run,
  cursor,
  onSeek: seek,
}: {
  run: Run;
  cursor: number;
  onSeek: (time: number) => void;
}) {
  const { complete, end } = getRunViewState(run, cursor);
  const [fileIndex, setFileIndex] = useState(() =>
      Math.max(
        0,
        run.changedFiles.findIndex((file) => !/\.(md|txt)$/i.test(file.path)),
      ),
    ),
    [showContext, setShowContext] = useState(false);
  const selectedFile =
    run.changedFiles[Math.min(Math.max(0, fileIndex), run.changedFiles.length - 1)];
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Goal changes')}</h2>
          <p className="caption">{t('Final diff of the selected run')}</p>
        </div>
        {!run.goalId && (
          <a className="text-button" href="/artifacts/CLI-IMPROVEMENTS.patch" download>
            <ArrowDownToLine size={14} /> {t('Combined patch')}
          </a>
        )}
      </div>
      {!complete && (
        <div className="snapshot-notice">
          <History size={14} /> {t('Final changes are available at the end of the recording.')}{' '}
          <button onClick={() => seek(end)}>
            {t('Go to result')} <ArrowRight size={12} />
          </button>
        </div>
      )}
      {complete && !run.changedFiles.length && (
        <EmptyState
          icon={FileCode2}
          title={t('No saved changes')}
          description={t('The diff will appear after files change in the workspace.')}
        />
      )}
      {complete && run.changedFiles.length > 0 && (
        <>
          <div className="diff-file-tabs">
            {run.changedFiles.map((f, i) => (
              <button
                key={f.path}
                className={fileIndex === i ? 'active' : ''}
                onClick={() => setFileIndex(i)}
              >
                <FileCode2 size={14} />
                {f.path}
              </button>
            ))}
          </div>
          <div className="diff-heading">
            <span className="mono">{selectedFile.path}</span>
            <Switch
              aria-label={t('Show diff context')}
              label={t('Context')}
              checked={showContext}
              onChange={(e) => setShowContext(e.currentTarget.checked)}
              size="xs"
            />
          </div>
          <div className="diff-code">
            {diffLines(selectedFile.before, selectedFile.after).map((line, i, lines) =>
              showContext ||
              line.kind !== 'same' ||
              lines.slice(Math.max(0, i - 2), i + 3).some((l) => l.kind !== 'same') ? (
                <div key={i} className={`diff-line ${line.kind}`}>
                  <span>{line.old || ''}</span>
                  <span>{line.next || ''}</span>
                  <b>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</b>
                  <code>{line.text || ' '}</code>
                </div>
              ) : null,
            )}
          </div>
        </>
      )}
    </div>
  );
}
