import { t } from '../../i18n/index.ts';
import { Button } from '@mantine/core';
import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RepositoryInfo, Run } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
export function ApplyRunResult({ run }: { run: Run }) {
  const { snapshot, client, connection } = useProject();
  const [info, setInfo] = useState<RepositoryInfo | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (snapshot?.project.managed && run.status === 'completed')
      void client!
        .command<RepositoryInfo>({
          method: 'project.info',
          params: { projectId: snapshot.project.id },
        })
        .then(setInfo)
        .catch((e) => setError(e.message));
  }, [client, snapshot?.project.id, run.id, run.status]);
  if (!snapshot?.project.managed || run.status !== 'completed' || !run.commit) return null;
  async function apply() {
    if (!info) return;
    setBusy(true);
    setError('');
    try {
      await client!.command({
        method: 'run.apply',
        params: {
          projectId: snapshot!.project.id,
          runId: run.id,
          expectedHead: info.head,
          expectedBranch: info.branch,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="apply-result">
      <h3>{t('Bring the result into the project')}</h3>
      <p className="caption">
        {run.appliedAt
          ? t('Applied to branch {p0}', { p0: run.appliedBranch })
          : t('Accepted commit: {p0}. Branch: {p1}.', {
              p0: run.commit.slice(0, 8),
              p1: info?.branch || '—',
            })}
      </p>
      {info?.dirty && (
        <div className="source-notice">
          <p>
            {t(
              'The source directory has uncommitted changes. Apply is blocked, but you can inspect the result in its separate workspace.',
            )}
          </p>
          <details>
            <summary>
              {t('Apply blockers ·')} {info.dirtyFiles.length}
            </summary>
            <pre className="terminal">{info.dirtyFiles.join('\n')}</pre>
          </details>
        </div>
      )}
      {!run.appliedAt && (
        <Button
          leftSection={<GitBranch size={14} />}
          loading={busy}
          disabled={!info || info.dirty || !info.branch || connection !== 'connected'}
          onClick={() => void apply()}
        >
          {t('Apply to branch')} {info?.branch || ''}
        </Button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
