import { t } from '../i18n/index.ts';
import { ArrowDownToLine, FileText, Folder } from 'lucide-react';
import { EmptyState } from '../components/molecules/EmptyState';
import { Panel } from '../components/molecules/Panel';
import { useProject } from '../data/provider';
import type { Run } from '../model';
function jsonLink(data: unknown) {
  return 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
}
export function FilesView({ run }: { run?: Run }) {
  const { snapshot } = useProject();
  if (!snapshot) return null;
  const directory = snapshot.project.dataDirectory;
  return (
    <Panel
      title={t('Project files')}
      description={t('Context, team and history stay next to the repository')}
      aside={<Folder size={23} className="muted" />}
    >
      {directory && <code className="source-path">{directory}</code>}
      <div className="artifact-list">
        {snapshot.profile && (
          <a
            download="project.json"
            href={jsonLink({
              version: 1,
              id: snapshot.project.id,
              name: snapshot.project.name,
              profile: snapshot.profile,
            })}
          >
            <FileText size={17} />
            <span>
              <b>{t('Project profile')}</b>
              <small className="mono">project.json</small>
            </span>
            <ArrowDownToLine size={15} />
          </a>
        )}
        {run && (
          <a download={`${run.id}.json`} href={jsonLink(run)}>
            <FileText size={17} />
            <span>
              <b>{t('Run with timeline and role snapshots')}</b>
              <small className="mono">{run.id}.json</small>
            </span>
            <ArrowDownToLine size={15} />
          </a>
        )}
      </div>
      {run?.workspace && (
        <div className="source-receipt">
          <Folder size={17} />
          <div>
            <b>{t('Run workspace')}</b>
            <code className="source-path">{run.workspace}</code>
            <p>
              {t('Accepted commit:')} {run.commit || t('Not yet')}
            </p>
          </div>
        </div>
      )}
      {!run && (
        <EmptyState
          icon={FileText}
          title={t('Artifacts will appear after a run starts')}
          description={t('The profile, roles and drafts are already saved in the project.')}
        />
      )}
      {run?.sourceHash && (
        <div className="source-receipt">
          <FileText size={17} />
          <div>
            <b>{t('Imported CLI recording')}</b>
            <p>{t('Saved event log for the selected run.')}</p>
            <span className="mono">SHA-256 · {run.sourceHash.slice(0, 24)}…</span>
          </div>
        </div>
      )}
    </Panel>
  );
}
