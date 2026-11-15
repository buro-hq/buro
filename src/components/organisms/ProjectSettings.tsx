import { t } from '../../i18n/index.ts';
import { Button } from '@mantine/core';
import { useState } from 'react';
import type { ProjectProfile, ProjectVerification } from '../../../protocol/domain.ts';
import { useProject } from '../../data/provider';
import { ProjectProfileForm } from './ProjectProfileForm';
import { ProjectResearchPanel } from './ProjectResearchPanel';
import { profileWithResearch } from '../../../protocol/research-profile';
export function ProjectSettings() {
  const { snapshot, client, connection } = useProject();
  const [checking, setChecking] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [result, setResult] = useState<ProjectVerification | null>(null);
  const [proposal, setProposal] = useState<ProjectProfile | null>(null);
  const [researchId, setResearchId] = useState<string | undefined>();
  if (!snapshot?.profile) return null;
  const displayed = checking ? null : result || snapshot.verification;
  const profile = snapshot.profile,
    busy = snapshot.runs.some(
      (r) => r.status && ['queued', 'running', 'canceling'].includes(r.status),
    );
  async function verify() {
    setChecking(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await client!.command({
          method: 'project.verify',
          params: { projectId: snapshot!.project.id, checkIds: profile.defaultCheckIds },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Project settings')}</h2>
          <p className="caption">
            {t('Profile')} {snapshot.project.name} {t('· version')} {profile.revision}
          </p>
        </div>
        <Button
          variant="light"
          size="xs"
          disabled={busy || connection !== 'connected' || !profile.defaultCheckIds.length}
          loading={checking}
          onClick={() => void verify()}
        >
          {t('Check environment')}
        </Button>
      </div>
      <code className="source-path">{snapshot.project.root}/.buro/project.json</code>
      {snapshot.capabilities.includes('project.research') && (
        <ProjectResearchPanel
          disabled={busy || checking}
          onAccept={
            snapshot.capabilities.includes('project.research.apply')
              ? async (research) => {
                  await client!.command({
                    method: 'project.research.apply',
                    params: {
                      projectId: snapshot.project.id,
                      researchId: research.id,
                      expectedRevision: profile.revision,
                    },
                  });
                  setSaved(true);
                  setProposal(null);
                  setResearchId(undefined);
                }
              : undefined
          }
          onApply={(research) => {
            setResearchId(research.id);
            setProposal(profileWithResearch(profile, research));
          }}
        />
      )}
      {busy && (
        <p className="source-notice">{t('Settings can be edited after the goal finishes.')}</p>
      )}
      {proposal && (
        <p className="source-notice">
          {t('Suggestions filled the form below. Review them and click Save settings.')}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      )}
      {displayed && (
        <div className="verification-result">
          <h3>
            {t('Checks:')} {displayed.passed}/{displayed.total}
          </h3>
          <p className="caption">
            {t('Profile v')}
            {displayed.profileRevision}
            {t('. Verified in a separate workspace. Source branch preserved.')}
          </p>
          {displayed.results.map((c) => (
            <details key={c.name}>
              <summary>
                {c.passed ? '✓' : '×'} {c.name}
              </summary>
              <pre className="terminal">
                {c.command}\n{c.output || c.error || ''}
              </pre>
            </details>
          ))}
        </div>
      )}
      <fieldset
        disabled={busy || checking || connection !== 'connected'}
        className="profile-fieldset"
      >
        <ProjectProfileForm
          key={profile.revision + (proposal ? '-proposal' : '')}
          initial={proposal || profile}
          projectId={snapshot.project.id}
          root={snapshot.project.root}
          submitLabel={t('Save settings')}
          onSave={async (next) => {
            await client!.command<ProjectProfile>({
              method: 'project.configure',
              params: {
                projectId: snapshot!.project.id,
                profile: next,
                expectedRevision: next.revision,
                ...(researchId ? { researchId } : {}),
              },
            });
            setSaved(true);
            setProposal(null);
            setResearchId(undefined);
          }}
        />
      </fieldset>
      {saved && (
        <p className="green-text" role="status">
          {t('Settings saved')}
        </p>
      )}
    </div>
  );
}
