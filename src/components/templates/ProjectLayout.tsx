import { t } from '../../i18n/index.ts';
import { ActionIcon, Button, Drawer, Select } from '@mantine/core';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Clock3,
  Folder,
  FolderGit2,
  GitBranch,
  History,
  LayoutGrid,
  Menu,
  Plus,
  Settings2,
  Target,
  Users,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useProject } from '../../data/provider';
import { isTerminal } from '../../model';
import { compactKey } from '../../ui/format';
import { ProjectPicker } from '../organisms/ProjectPicker';
import { BrandMark } from '../atoms/BrandMark';
export type ProjectPage =
  | 'office'
  | 'goals'
  | 'runs'
  | 'team'
  | 'files'
  | 'settings'
  | 'preferences';
const navigation = [
  {
    id: 'office',
    get label() {
      return t('Office');
    },
    icon: LayoutGrid,
  },
  {
    id: 'goals',
    get label() {
      return t('Goals');
    },
    icon: Target,
  },
  {
    id: 'runs',
    get label() {
      return t('Runs');
    },
    icon: History,
  },
  {
    id: 'team',
    get label() {
      return t('Team');
    },
    icon: Users,
  },
  {
    id: 'files',
    get label() {
      return t('.buro files');
    },
    icon: Folder,
  },
] as const;
/** One application frame for every project, independent of its run history. */
export function ProjectLayout({
  page,
  onNavigate,
  onNewGoal,
  selectedRunId,
  onSelectRun,
  children,
}: {
  page: ProjectPage;
  onNavigate: (page: ProjectPage) => void;
  onNewGoal: () => void;
  selectedRunId?: string;
  onSelectRun?: (id: string) => void;
  children: ReactNode;
}) {
  const { snapshot, mode, connection, error, switchMode } = useProject();
  const [projects, setProjects] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
  if (!snapshot) return null;
  const { project, runs, goals } = snapshot,
    goalCount = new Set([...goals.map((g) => g.id), ...runs.map((r) => r.goalId || r.id)]).size;
  const go = (next: ProjectPage) => {
    setMobileNav(false);
    onNavigate(next);
  };
  const sidebar = (
    <>
      <button className="brand" onClick={() => go('office')}>
        <span className="brand-mark">
          <BrandMark size={28} />
        </span>
        <span>
          Buro<span className="brand-version">LOCAL WORKSPACE</span>
        </span>
      </button>
      <button className="project-switch" onClick={() => setProjects(true)}>
        <span className="project-avatar">
          <Box size={20} />
        </span>
        <span>
          <b>{project.name}</b>
          <small>{t('Local project')}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      <div className="sidebar-label">{t('PROJECT')}</div>
      <nav>
        {navigation.map((n) => (
          <button
            key={n.id}
            aria-label={n.label}
            className={`nav-item ${page === n.id ? 'active' : ''}`}
            onClick={() => go(n.id)}
          >
            <n.icon size={17} />
            <span>{n.label}</span>
            {n.id === 'goals' && <small>{goalCount}</small>}
            {n.id === 'office' && <i />}
          </button>
        ))}
      </nav>
      <div className="sidebar-label side-goal-label">
        {t('RECENT GOALS')}{' '}
        <button aria-label={t('Add goal')} onClick={onNewGoal}>
          <Plus size={14} />
        </button>
      </div>
      <div className="side-goals">
        {runs.map((r) => (
          <button
            key={r.id}
            className={selectedRunId === r.id ? 'selected' : ''}
            onClick={() => {
              setMobileNav(false);
              onSelectRun?.(r.id);
            }}
          >
            {r.status && r.status !== 'completed' ? (
              isTerminal(r) ? (
                <X size={14} />
              ) : (
                <Clock3 size={14} />
              )
            ) : (
              <CircleCheck size={14} />
            )}
            <span>
              <small>{compactKey(r.key)}</small>
              {r.title}
            </span>
          </button>
        ))}
        {!runs.length &&
          goals
            .slice(-5)
            .reverse()
            .map((g) => (
              <button key={g.id} onClick={() => go('goals')}>
                <Circle size={14} />
                <span>
                  <small>{t('Draft')}</small>
                  {g.title}
                </span>
              </button>
            ))}
        {!runs.length && !goals.length && <p className="empty-recent-goals">{t('No goals yet')}</p>}
      </div>
      <div className="sidebar-bottom">
        <div className="local-storage">
          <Folder size={16} />
          <div>
            <b>{t('Everything next to the code')}</b>
            <small>{project.root.split('/').at(-1)} / .buro</small>
          </div>
          <span className="connection-dot" />
        </div>
        <button
          className={`nav-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => go('settings')}
        >
          <Settings2 size={17} />
          <span>{t('Project settings')}</span>
        </button>
        <button
          className="profile"
          aria-label={t('User settings')}
          onClick={() => go('preferences')}
        >
          <span className="user-avatar">
            <Users size={14} />
          </span>
          <span>
            {t('Local user')}
            <small>{t('Local session')}</small>
          </span>
          <span className="keycap">⌘ K</span>
        </button>
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
            variant="subtle"
            color="gray"
            aria-label={t('Navigation')}
            onClick={() => setMobileNav(true)}
          >
            <Menu size={20} />
          </ActionIcon>
          <div className="breadcrumbs">
            <button onClick={() => setProjects(true)}>{t('Projects')}</button>
            <ChevronRight size={12} />
            <button onClick={() => go('office')}>
              <Box size={14} />
              {project.name}
            </button>
            <ChevronRight size={12} />
            <span>
              {navigation.find((n) => n.id === page)?.label ||
                (page === 'preferences' ? t('User settings') : t('Settings'))}
            </span>
          </div>
          <div className="topbar-right">
            <Select
              aria-label={t('Data source')}
              className="source-select"
              value={mode}
              onChange={(v) => void switchMode(v === 'service' ? 'service' : 'replay')}
              data={[
                {
                  value: 'service',
                  label:
                    connection === 'connected' && mode === 'service'
                      ? t('Service connected')
                      : t('Local service'),
                },
                { value: 'replay', label: t('Offline drafts') },
              ]}
              size="xs"
              allowDeselect={false}
            />
            <button
              className="top-avatar"
              aria-label={t('Open user settings')}
              onClick={() => go('preferences')}
            >
              <Users size={14} />
            </button>
          </div>
        </header>
        <div className="workspace-scroll">
          <main className="project-main">
            <div className="project-heading">
              <div>
                <div className="eyebrow">
                  <FolderGit2 size={13} /> {t('WORKSPACE')}
                </div>
                <h1>
                  {project.name}
                  <span className="project-dot" aria-hidden="true">
                    .
                  </span>
                </h1>
                <p>{t('Your project. Its goals. A team of agents.')}</p>
              </div>
              <div className="hero-actions">
                <span className="project-branch">
                  <GitBranch size={14} />
                  {project.managed ? 'Git worktree' : 'local / poc'}
                </span>
                <Button leftSection={<Plus size={15} />} onClick={onNewGoal}>
                  {t('New goal')}
                </Button>
              </div>
            </div>
            {error && <div className="source-notice">{t(error)}</div>}
            {connection === 'reconnecting' && mode === 'service' && (
              <div className="source-notice">
                {t('Reconnecting to the service. The latest snapshot remains on screen.')}
              </div>
            )}
            <div className="project-nav">
              <button className={page === 'office' ? 'active' : ''} onClick={() => go('office')}>
                <LayoutGrid size={15} />
                {t('Office')}
              </button>
              <button className={page === 'goals' ? 'active' : ''} onClick={() => go('goals')}>
                <Target size={15} />
                {t('Goals')} <span>{goalCount}</span>
              </button>
              <button className={page === 'runs' ? 'active' : ''} onClick={() => go('runs')}>
                <History size={15} />
                {t('Runs')} <span>{runs.length}</span>
              </button>
              <button className={page === 'team' ? 'active' : ''} onClick={() => go('team')}>
                <Users size={15} />
                {t('Team')}
              </button>
              <div className="project-nav-meta">
                <span className="tiny-dot done" />
                {t('Accepted goals:')}{' '}
                {runs.filter((r) => !r.status || r.status === 'completed').length}
              </div>
            </div>
            {children}
            <footer className="workspace-footer">
              <span>
                <BrandMark size={12} />
                Buro <span className="muted">{t('/ local agent office')}</span>
              </span>
              <span>{t('React · Mantine · local agent office')}</span>
            </footer>
          </main>
        </div>
      </div>
      <Drawer
        opened={mobileNav}
        onClose={() => setMobileNav(false)}
        position="left"
        size={250}
        withCloseButton={false}
        className="mobile-drawer"
      >
        <div className="mobile-sidebar">{sidebar}</div>
      </Drawer>
      <ProjectPicker opened={projects} onClose={() => setProjects(false)} />
    </div>
  );
}
