import { useLocale, t } from './i18n/index.ts';
import { Button, Stack, Text, Title } from '@mantine/core';
import { History } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from './components/molecules/EmptyState';
import { Panel } from './components/molecules/Panel';
import { RunContext } from './components/molecules/RunContext';
import { RunPlayer } from './components/molecules/RunPlayer';
import { RunTabs, type RunTab } from './components/molecules/RunTabs';
import { ChangesPanel } from './components/organisms/ChangesPanel';
import { ChecksPanel } from './components/organisms/ChecksPanel';
import { EmptyOffice, EmptyOfficeRail } from './components/organisms/EmptyOffice';
import { GoalModal } from './components/organisms/GoalModal';
import { PlanPanel } from './components/organisms/PlanPanel';
import { ResultPanel } from './components/organisms/ResultPanel';
import { RunInspector } from './components/organisms/RunInspector';
import { RunOffice } from './components/organisms/RunOffice';
import { RunRail } from './components/organisms/RunRail';
import { RunRecoveryPanel } from './components/organisms/RunRecoveryPanel';
import { TeamPanel } from './components/organisms/TeamPanel';
import { TimelinePanel } from './components/organisms/TimelinePanel';
import { ProjectLayout, type ProjectPage } from './components/templates/ProjectLayout';
import { ProjectResearchPanel } from './components/organisms/ProjectResearchPanel';
import { Notice } from './components/atoms/Notice';
import { BrandMark } from './components/atoms/BrandMark';
import { useProject } from './data/provider';
import { useRunPlayback } from './hooks/useRunPlayback';
import { roleViewsForRun, type Milestone } from './model';
import { FilesView } from './pages/FilesView';
import { GoalsView } from './pages/GoalsView';
import { SettingsView } from './pages/SettingsView';
import { UserSettingsPage } from './pages/UserSettingsPage';
import { ProjectPicker } from './components/organisms/ProjectPicker';
import { ExecutionResources } from './components/organisms/ExecutionResources';
export default function App() {
  useLocale();
  const data = useProject();
  if (data.client && data.service && data.connection === 'connected' && !data.snapshot)
    return <ServiceOnboarding />;
  if (!data.snapshot || !data.client)
    return (
      <div className="startup">
        <span className="startup-logo">
          <BrandMark size={32} />
          Buro
        </span>
        <p>{data.error || t('Connecting to the project office…')}</p>
        <Button variant="default" onClick={() => void data.switchMode('service')}>
          {t('Reconnect')}
        </Button>
        <Button onClick={() => void data.switchMode('replay')}>{t('Offline drafts')}</Button>
      </div>
    );
  return <ProjectWorkspace key={data.snapshot.project.id} />;
}
function ServiceOnboarding() {
  const { service, error } = useProject();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  return (
    <main className="startup service-onboarding">
      <Stack gap="md" maw={640} w="100%" px="xl">
        <span className="startup-logo">
          <BrandMark size={32} />
          Buro
        </span>
        <Title order={1} c="var(--text)">
          {t('Your workspace starts with a project')}
        </Title>
        <Text c="dimmed">
          {t('Connect a Git repository. Buro keeps its goals, team and results together.')}
        </Text>
        {error && (
          <Text c="red" role="alert">
            {error}
          </Text>
        )}
        <Button
          size="md"
          w="fit-content"
          onClick={() => setProjectsOpen(true)}
          disabled={!service?.projects.length && !service?.capabilities.includes('project.connect')}
        >
          {service?.projects.length ? t('Choose project') : t('Connect project')}
        </Button>
        {service?.capabilities.includes('resources.list') && (
          <Button variant="subtle" onClick={() => setModelsOpen((value) => !value)}>
            {t('Configure models')}
          </Button>
        )}
        {modelsOpen && <ExecutionResources />}
      </Stack>
      <ProjectPicker opened={projectsOpen} onClose={() => setProjectsOpen(false)} />
    </main>
  );
}
function ProjectWorkspace() {
  const locale = useLocale();
  const { snapshot, client, mode, connection } = useProject();
  const state = snapshot!,
    runs = state.runs;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.id || null),
    [page, setPage] = useState<ProjectPage>('office'),
    [tab, setTab] = useState<RunTab>('timeline'),
    [newGoal, setNewGoal] = useState(false),
    [detail, setDetail] = useState<Milestone | null>(null),
    [agentDetail, setAgentDetail] = useState<string | null>(null);
  const run = runs.find((item) => item.id === selectedRunId) || runs[0],
    playback = useRunPlayback(run),
    roles = useMemo(
      () => (run ? roleViewsForRun(state.roles, run) : {}),
      [state.roles, run, locale],
    );
  function closeInspector() {
    setDetail(null);
    setAgentDetail(null);
  }
  function selectRun(id: string) {
    setSelectedRunId(id);
    setPage('office');
    closeInspector();
  }
  function inspect(event: Milestone | null) {
    setAgentDetail(null);
    setDetail(event);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest('input,textarea,button,[role="slider"],[role="combobox"]') ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (event.code === 'Space' && run && ['office', 'runs'].includes(page)) {
        event.preventDefault();
        playback.play();
      }
      if (event.key === '/' && run) {
        event.preventDefault();
        setPage('runs');
        setTab('timeline');
        setTimeout(
          () => document.querySelector<HTMLInputElement>('[aria-label="Search events"]')?.focus(),
          0,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, page, playback.play]);
  const viewTimeline = () => {
    setPage('runs');
    setTab('timeline');
  };
  const hasRail = page === 'office' || (page === 'runs' && !!run);
  return (
    <ProjectLayout
      page={page}
      onNavigate={setPage}
      onNewGoal={() => setNewGoal(true)}
      selectedRunId={run?.id}
      onSelectRun={selectRun}
    >
      {run && ['office', 'runs'].includes(page) && (
        <RunContext
          run={run}
          runs={runs}
          runIndex={runs.indexOf(run)}
          cursor={playback.cursor}
          onSelectRun={(index) => {
            setSelectedRunId(runs[index].id);
            closeInspector();
          }}
          onViewPlan={() => {
            setPage('runs');
            setTab('plan');
          }}
        />
      )}
      {run && ['office', 'runs'].includes(page) && (
        <RunRecoveryPanel compact run={run} onResumed={selectRun} />
      )}
      <div className={`workspace-columns ${hasRail ? 'with-rail' : ''}`}>
        <section className="workspace-primary">
          {page === 'office' && state.research?.status === 'running' && <ProjectResearchPanel />}
          {page === 'office' &&
            state.research &&
            state.research.status !== 'running' &&
            !state.research.appliedProfileRevision &&
            !state.research.reviewedProfileRevision && (
              <Notice>
                {state.research.status === 'ready'
                  ? t(
                      'Project research is ready. Review the suggestions and complete the settings.',
                    )
                  : t('Research stopped. The saved result is available in project settings.')}
                <Button variant="subtle" size="xs" onClick={() => setPage('settings')}>
                  {t('Configure project')}
                </Button>
              </Notice>
            )}
          {page === 'office' &&
            (run ? (
              <RunOffice
                run={run}
                cursor={playback.cursor}
                roles={roles}
                projectName={state.project.name}
                onAgent={setAgentDetail}
                onInspect={inspect}
                onViewTimeline={viewTimeline}
              />
            ) : (
              <EmptyOffice onNewGoal={() => setNewGoal(true)} onNavigate={setPage} />
            ))}
          {page === 'runs' &&
            (run ? (
              <>
                <RunTabs value={tab} onChange={setTab} />
                <div role="tabpanel" key={run.id}>
                  {tab === 'timeline' ? (
                    <TimelinePanel
                      run={run}
                      cursor={playback.cursor}
                      roles={roles}
                      onAgent={setAgentDetail}
                      onInspect={inspect}
                    />
                  ) : tab === 'plan' ? (
                    <PlanPanel run={run} cursor={playback.cursor} roles={roles} />
                  ) : tab === 'changes' ? (
                    <ChangesPanel run={run} cursor={playback.cursor} onSeek={playback.seek} />
                  ) : tab === 'checks' ? (
                    <ChecksPanel run={run} cursor={playback.cursor} onInspect={inspect} />
                  ) : (
                    <ResultPanel run={run} cursor={playback.cursor} />
                  )}
                </div>
              </>
            ) : (
              <Panel title={t('Runs')}>
                <EmptyState
                  icon={History}
                  title={t('No runs yet')}
                  description={t(
                    'Start a goal to see its plan, timeline, changes and checks here.',
                  )}
                  action={
                    <Button variant="light" onClick={() => setPage('goals')}>
                      {t('Go to goals')}
                    </Button>
                  }
                />
              </Panel>
            ))}
          {page === 'goals' && (
            <GoalsView
              onNewGoal={() => setNewGoal(true)}
              onSelectRun={selectRun}
              onRunStarted={selectRun}
            />
          )}{' '}
          {page === 'team' && (
            <TeamPanel
              roles={state.roles}
              run={run}
              canEdit={mode === 'service' && connection === 'connected'}
              projectId={state.project.id}
              onSession={setAgentDetail}
              onSave={(input) => client!.saveRole(input)}
            />
          )}{' '}
          {page === 'files' && <FilesView run={run} />} {page === 'settings' && <SettingsView />}
          {page === 'preferences' && <UserSettingsPage />}
          {run && ['office', 'runs'].includes(page) && <RunPlayer run={run} playback={playback} />}
        </section>
        {hasRail &&
          (run ? (
            <RunRail run={run} cursor={playback.cursor} roles={roles} onAgent={setAgentDetail} />
          ) : (
            <EmptyOfficeRail onNavigate={setPage} />
          ))}
      </div>
      <GoalModal
        opened={newGoal}
        onClose={() => setNewGoal(false)}
        onCreated={() => setPage('goals')}
      />
      {run && (
        <RunInspector
          run={run}
          cursor={playback.cursor}
          roles={roles}
          detail={detail}
          agentDetail={agentDetail}
          onClose={closeInspector}
          onInspect={inspect}
          onRepair={(time) => {
            playback.seek(time);
            setPage('runs');
            setTab('checks');
            closeInspector();
          }}
        />
      )}
    </ProjectLayout>
  );
}
