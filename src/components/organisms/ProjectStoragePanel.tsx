import { t } from '../../i18n/index.ts';
import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { ProjectStorageInfo } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { Notice } from '../atoms/Notice';
import { Panel } from '../molecules/Panel';
export function ProjectStoragePanel() {
  const { snapshot, client, connection } = useProject();
  const [info, setInfo] = useState<ProjectStorageInfo | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const supported = !!snapshot?.capabilities.includes('project.storage');
  useEffect(() => {
    let current = true;
    if (supported && client && snapshot)
      void client
        .command<ProjectStorageInfo>({
          method: 'project.storage',
          params: { projectId: snapshot.project.id },
        })
        .then((value) => {
          if (current) setInfo(value);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [client, snapshot?.project.id, supported]);
  if (!supported) return null;
  async function cleanup() {
    setBusy(true);
    setError('');
    try {
      setInfo(
        await client!.command<ProjectStorageInfo>({
          method: 'project.storage.gc',
          params: { projectId: snapshot!.project.id },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={t('Project storage')}
      description={t(
        'The journal stores changes between events. Goals, history, role versions and workspaces are preserved.',
      )}
      className="project-storage-panel"
    >
      {info && (
        <p className="caption">
          {t('State:')} {(info.stateBytes / 1024 / 1024).toFixed(2)} {t('MB · events:')}{' '}
          {info.eventCount} {t('· compacted updates:')} {info.compactedEvents}
        </p>
      )}
      <p className="caption">
        {t('Only atomic-write temporary files older than one day are removed automatically.')}
      </p>
      {info?.removedTempFiles !== undefined && (
        <Notice tone="success">
          {t('Temporary files removed:')} {info.removedTempFiles}
          {t('. Reclaimed')} {((info.reclaimedBytes || 0) / 1024) | 0} {t('KB.')}
        </Notice>
      )}
      {error && <Notice tone="error">{t(error)}</Notice>}
      <Button
        variant="default"
        loading={busy}
        disabled={connection !== 'connected'}
        onClick={() => void cleanup()}
      >
        {t('Clean temporary files')}
      </Button>
    </Panel>
  );
}
