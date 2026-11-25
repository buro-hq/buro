import { ActionIcon, Button, Drawer, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  LayoutGrid,
  Bot,
  ChevronDown,
  Cpu,
  Files,
  History,
  Menu,
  Settings2,
  Target,
} from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from './data/application.tsx';
import { useLocale, t } from './i18n/index.ts';
import { BrandMark } from './components/atoms/BrandMark.tsx';
import { ProjectPicker } from './features/projects/ProjectPicker.tsx';
import { TasksPage } from './features/tasks/TasksPage.tsx';
import { OfficePage } from './features/runs/OfficePage.tsx';
import { RunsPage } from './features/runs/RunsPage.tsx';
import { AgentsPage } from './features/agents/AgentsPage.tsx';
import { ModelsPage } from './features/models/ModelsPage.tsx';
import { MaterialsPage } from './features/materials/MaterialsPage.tsx';
import { PreferencesPage } from './features/settings/PreferencesPage.tsx';
import { ErrorNotice, QueryFeedback } from './features/common/feedback.tsx';

const navigation = [
  { id: 'office', label: 'Office', icon: LayoutGrid },
  { id: 'tasks', label: 'Goals', icon: Target },
  { id: 'runs', label: 'Runs', icon: History },
  { id: 'materials', label: 'Materials', icon: Files },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const;
type Page = (typeof navigation)[number]['id'];

/** The frame owns navigation only. Feature pages read and mutate their own data. */
export const Application = (): ReactElement => {
  useLocale();
  const { connection } = useApplication();
  const projects = useApiQuery('projects.list', {});
  const [page, setPage] = useState<Page>('office');
  const [picker, setPicker] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [selectedRun, setSelectedRun] = useState<{ projectId: string; id: string }>();
  const [projectId, setProjectId] = useLocalStorage<string>({
    key: 'buro.selected-project',
    defaultValue: '',
  });
  const project =
    projects.data?.find((candidate) => candidate.id === projectId) ?? projects.data?.[0];
  const navigate = (next: Page): void => {
    setPage(next);
    setMobile(false);
  };
  const sidebar = (
    <>
      <button className="brand" onClick={() => navigate('tasks')}>
        <span className="brand-mark">
          <BrandMark size={28} />
        </span>
        <span>
          Buro<span className="brand-version">LOCAL WORKSPACE</span>
        </span>
      </button>
      <button className="project-switch" onClick={() => setPicker(true)}>
        <span>
          <b>{project?.name ?? t('Choose project')}</b>
          <small>{t('Local project')}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      <nav>
        {navigation.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => navigate(item.id)}
          >
            <item.icon size={17} />
            <span>{t(item.label)}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <Text size="xs" c="dimmed">
          {t(connection.connected ? 'Service connected' : 'Connecting…')}
        </Text>
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">{sidebar}</aside>
      <div className="app-body">
        <header className="topbar">
          <ActionIcon
            className="mobile-menu"
            aria-label={t('Navigation')}
            variant="subtle"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </ActionIcon>
          <div className="breadcrumbs">
            <button onClick={() => setPicker(true)}>{project?.name ?? t('Projects')}</button>
            <span>/ {t(navigation.find((item) => item.id === page)!.label)}</span>
          </div>
          <div className="topbar-right">
            <Button size="xs" variant="subtle" onClick={() => setPicker(true)}>
              {t('Projects')}
            </Button>
          </div>
        </header>
        <div className="workspace-scroll">
          <main className="project-main">
            <div className="project-heading">
              <div>
                <h1>
                  {project?.name ?? 'Buro'}
                  <span className="project-dot">.</span>
                </h1>
                <p>{project?.root ?? t('Your project. Its goals. A team of agents.')}</p>
              </div>
            </div>
            <Stack gap="md">
              <ErrorNotice
                error={
                  connection.authorizationRequired
                    ? t('Open Buro from its launcher to connect this browser.')
                    : undefined
                }
              />
              {['office', 'tasks', 'runs', 'materials'].includes(page) && !project && (
                <>
                  <QueryFeedback loading={projects.loading} error={projects.error} />
                  <Text c="dimmed">{t('Choose a project to work with its goals and runs.')}</Text>
                  <Button onClick={() => setPicker(true)}>{t('Connect project')}</Button>
                </>
              )}
              {project && page === 'office' && (
                <OfficePage
                  key={project.id}
                  projectId={project.id}
                  onRun={(id) => {
                    setSelectedRun({
                      projectId: project.id,
                      id,
                    });
                    navigate('runs');
                  }}
                />
              )}
              {project && page === 'tasks' && (
                <TasksPage
                  key={project.id}
                  projectId={project.id}
                  onRun={(id) => {
                    setSelectedRun({
                      projectId: project.id,
                      id,
                    });
                    navigate('runs');
                  }}
                />
              )}
              {project && page === 'runs' && (
                <RunsPage
                  key={project.id}
                  projectId={project.id}
                  selectedId={selectedRun?.projectId === project.id ? selectedRun.id : undefined}
                  onSelect={(id) => setSelectedRun(id ? { projectId: project.id, id } : undefined)}
                />
              )}
              {project && page === 'materials' && (
                <MaterialsPage key={project.id} projectId={project.id} />
              )}
              {page === 'agents' && <AgentsPage />}
              {page === 'models' && <ModelsPage />}
              {page === 'settings' && <PreferencesPage />}
            </Stack>
            <footer className="workspace-footer">
              <span>
                <BrandMark size={12} />
                Buro
              </span>
              <span>{t('Local agent workspace')}</span>
            </footer>
          </main>
        </div>
      </div>
      <Drawer opened={mobile} onClose={() => setMobile(false)} position="left" title="Buro">
        <div className="feature-mobile-nav">{sidebar}</div>
      </Drawer>
      <ProjectPicker
        opened={picker}
        onClose={() => setPicker(false)}
        onSelect={(selected) => {
          setProjectId(selected.id);
          setSelectedRun(undefined);
          setMobile(false);
        }}
      />
    </div>
  );
};
