import { t } from '../../i18n/index.ts';
import { Badge, Button, Checkbox, Modal, TextInput } from '@mantine/core';
import { ArrowRight, FolderGit2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  Project,
  ProjectProfile,
  ProjectResearch,
  RepositoryInfo,
} from '../../../protocol/domain';
import { useProject } from '../../data/provider';
import { PathInput } from '../molecules/PathInput';
import { ProjectProfileForm } from './ProjectProfileForm';
import { ProjectResearchPanel } from './ProjectResearchPanel';
import { profileWithResearch } from '../../../protocol/research-profile';

export function ProjectPicker({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { projects, snapshot, client, mode, refreshProjects, switchProject } = useProject();
  const [root, setRoot] = useState(''),
    [name, setName] = useState(''),
    [info, setInfo] = useState<RepositoryInfo | null>(null),
    [form, setForm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [autoResearch, setAutoResearch] = useState(true),
    [ignoreLocal, setIgnoreLocal] = useState(true),
    [connected, setConnected] = useState<Project | null>(null),
    [studying, setStudying] = useState(false),
    [proposal, setProposal] = useState<ProjectProfile | null>(null);
  const supportsResearch = !!snapshot?.capabilities.includes('project.research');
  useEffect(() => {
    if (opened) {
      void refreshProjects().catch((e) => setError(e.message));
      setError('');
    }
  }, [opened, refreshProjects]);
  async function inspect() {
    setBusy(true);
    setError('');
    setConnected(null);
    setProposal(null);
    try {
      const value = await client!.command<RepositoryInfo>({
        method: 'project.inspect',
        params: { root },
      });
      setInfo(value);
      setRoot(value.root);
      setName(value.name);
      if (!value.projectId && autoResearch && supportsResearch) {
        const project = await client!.command<Project>({
          method: 'project.connect',
          params: { root: value.root, name: value.name, profile: value.profile, ignoreLocal },
        });
        setInfo(
          await client!.command<RepositoryInfo>({
            method: 'project.info',
            params: { projectId: project.id },
          }),
        );
        setConnected(project);
        setStudying(true);
        await client!.command({ method: 'project.research', params: { projectId: project.id } });
        await refreshProjects();
      }
    } catch (e) {
      setError((e as Error).message);
      setStudying(false);
    } finally {
      setBusy(false);
    }
  }
  async function select(id: string) {
    setBusy(true);
    setError('');
    try {
      await switchProject(id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function researchReady(research: ProjectResearch) {
    setStudying(false);
    if (research.status === 'ready' && info) {
      setProposal(profileWithResearch(info.profile, research));
    }
  }
  const list = mode === 'service' ? projects : snapshot ? [snapshot.project] : [];
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <span className="modal-title">
          <FolderGit2 size={18} />
          {studying ? t('Project setup') : t('Projects')}
        </span>
      }
      size={form ? 'lg' : 'md'}
      centered
    >
      <div className="projects-modal">
        {!studying && (
          <>
            <p className="caption">{t('Each project has its own office, goals and team.')}</p>
            {list.map((project) => (
              <button
                className="connected-project"
                key={project.id}
                disabled={busy}
                onClick={() => (mode === 'service' ? void select(project.id) : onClose())}
              >
                <span className="project-avatar">
                  <FolderGit2 size={21} />
                </span>
                <div>
                  <b>{project.name}</b>
                  <small>{project.root}</small>
                </div>
                {project.id === snapshot?.project.id ? (
                  <Badge size="xs" variant="light">
                    {t('Current')}
                  </Badge>
                ) : (
                  <ArrowRight size={15} />
                )}
              </button>
            ))}
            {mode === 'service' ? (
              <>
                <Button
                  variant="light"
                  size="xs"
                  disabled={!snapshot?.capabilities.includes('project.connect')}
                  leftSection={<Plus size={13} />}
                  onClick={() => setForm((v) => !v)}
                >
                  {t('Connect project')}
                </Button>
                {!snapshot?.capabilities.includes('project.connect') && (
                  <p className="source-notice">
                    {t('The service is outdated. Restart it to connect projects.')}
                  </p>
                )}
              </>
            ) : (
              <p className="caption">{t('Select the local service to connect a repository.')}</p>
            )}
          </>
        )}
        {form && (
          <div className="connect-project-form">
            {!studying && (
              <>
                <PathInput
                  label={t('Repository path')}
                  placeholder="/Users/you/projects/my-app"
                  value={root}
                  disabled={!!connected}
                  onChange={(value) => {
                    setRoot(value);
                    setInfo(null);
                  }}
                />
                {!connected && (
                  <>
                    <Checkbox
                      label={t('Research project')}
                      checked={autoResearch && supportsResearch}
                      disabled={!supportsResearch}
                      description={t(
                        'After you choose a directory, an agent suggests components, commands and ways to verify the result.',
                      )}
                      onChange={(e) => setAutoResearch(e.currentTarget.checked)}
                    />
                    <Checkbox
                      label={t('Add local/ to .buro/.gitignore')}
                      checked={ignoreLocal}
                      onChange={(e) => setIgnoreLocal(e.currentTarget.checked)}
                    />
                    <Button
                      variant="default"
                      loading={busy}
                      disabled={!root.trim()}
                      onClick={() => void inspect()}
                    >
                      {autoResearch && supportsResearch
                        ? t('Research directory')
                        : t('Inspect directory')}
                    </Button>
                  </>
                )}
              </>
            )}
            {connected && <ProjectResearchPanel projectId={connected.id} onReady={researchReady} />}
            {studying && (
              <>
                <p className="caption">
                  {t(
                    'The project is saved. You can close this window: research continues and its result will appear in project settings.',
                  )}
                </p>
                <Button variant="default" onClick={() => void select(connected!.id)}>
                  {t('Open project')}
                </Button>
              </>
            )}
            {info && !studying && (
              <>
                <div className="repository-info">
                  <b>{info.branch || 'detached HEAD'}</b>
                  <span className="mono">{info.head.slice(0, 8)}</span>
                  <span>
                    {info.dirty
                      ? t('{p0} uncommitted files', { p0: info.dirtyFiles.length })
                      : t('Working directory is clean')}
                  </span>
                </div>
                {info.warnings.map((w) => (
                  <p className="source-notice" key={w}>
                    {w}
                  </p>
                ))}
                {info.projectId && !connected ? (
                  <Button onClick={() => void select(info.projectId!)}>
                    {t('Open connected project')}
                  </Button>
                ) : (
                  <>
                    <TextInput
                      label={t('Project name')}
                      value={name}
                      disabled={!!connected}
                      onChange={(e) => setName(e.currentTarget.value)}
                    />
                    <p className="caption">
                      {t(
                        'Shared profile: .buro/project.json. Local settings: .buro/local/. Suggested commands have not been executed yet; migrations are excluded.',
                      )}
                    </p>
                    {!ignoreLocal && (
                      <p className="source-notice">
                        {t('Add .buro/local/ to Git ignore manually before saving local settings.')}
                      </p>
                    )}
                    <ProjectProfileForm
                      key={proposal ? 'research-' + connected?.id : info.root}
                      initial={proposal || info.profile}
                      projectId={connected?.id || info.projectId}
                      root={info.root}
                      submitLabel={connected ? t('Save and open') : t('Connect and open')}
                      onSave={async (profile) => {
                        let project = connected;
                        if (project) {
                          const research = proposal
                            ? await client!.command<ProjectResearch>({
                                method: 'project.research.status',
                                params: { projectId: project.id },
                              })
                            : null;
                          await client!.command({
                            method: 'project.configure',
                            params: {
                              projectId: project.id,
                              profile,
                              expectedRevision: info.profile.revision,
                              ...(research ? { researchId: research.id } : {}),
                            },
                          });
                        } else
                          project = await client!.command<Project>({
                            method: 'project.connect',
                            params: { root: info.root, name, profile, ignoreLocal },
                          });
                        await refreshProjects();
                        await select(project.id);
                      }}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {t(error)}
          </p>
        )}
      </div>
    </Modal>
  );
}
