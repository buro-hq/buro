import { t } from '../i18n/index.ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Connection, ProjectClient } from '../../clients/project-client.ts';
import { ReplayProjectClient } from '../../clients/replay-client.ts';
import { SocketProjectClient } from '../../clients/socket-client.ts';
import type { Goal, Project, Snapshot } from '../../protocol/domain.ts';
import { parseSnapshot } from '../../protocol/schema.ts';

type DataContext = {
  snapshot: Snapshot | null;
  client: ProjectClient | null;
  mode: 'service' | 'replay';
  connection: Connection;
  error: string;
  switchMode: (mode: 'service' | 'replay') => Promise<Snapshot | undefined>;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  switchProject: (id: string) => Promise<void>;
};
const Context = createContext<DataContext | null>(null);
async function replay() {
  const project = { id: 'codex-panel', name: 'Buro', root: '.' };
  let goals: Goal[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem('project-panel-drafts-v1') || '[]');
    if (Array.isArray(saved))
      goals = saved
        .filter((g) => g && typeof g.title === 'string' && typeof g.body === 'string')
        .map((g) => ({ ...g, projectId: project.id, status: 'draft' }));
  } catch {}
  return new ReplayProjectClient(
    parseSnapshot({
      version: 1,
      project,
      revision: 0,
      sequence: 0,
      roles: [],
      goals,
      runs: [],
      capabilities: ['history.read', 'goals.local-drafts'],
    }),
  );
}
function daemonUrl() {
  const value = new URLSearchParams(location.search).get('daemon') || 'ws://127.0.0.1:4341';
  const url = new URL(value);
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw Error(t('A local service address is required.'));
  return value;
}
export function ProjectProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [client, setClient] = useState<ProjectClient | null>(null);
  const [mode, setMode] = useState<'service' | 'replay'>('replay'),
    [connection, setConnection] = useState<Connection>('connecting'),
    [error, setError] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const selected = useRef(
    new URLSearchParams(location.search).get('project') ||
      localStorage.getItem('project-panel-last-project') ||
      'codex-panel',
  );
  const current = useRef<ProjectClient | null>(null),
    generation = useRef(0),
    unsubscribers = useRef<(() => void)[]>([]);
  const switchMode = useCallback(
    async (next: 'service' | 'replay', projectId = selected.current) => {
      const version = ++generation.current;
      setConnection('connecting');
      setError('');
      let candidate: ProjectClient | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        candidate =
          next === 'service' ? new SocketProjectClient(daemonUrl(), projectId) : await replay();
        const value = await Promise.race([
          candidate.connect(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(Error(t('Could not connect to the local service. Try reconnecting.'))),
              8000,
            );
          }),
        ]);
        if (version !== generation.current) {
          candidate.close();
          return;
        }
        for (const unsubscribe of unsubscribers.current) unsubscribe();
        current.current?.close();
        current.current = candidate;
        setClient(candidate);
        setSnapshot(value);
        setMode(candidate.mode);
        setConnection('connected');
        if (next === 'service') {
          selected.current = value.project.id;
          localStorage.setItem('project-panel-last-project', value.project.id);
          void candidate
            .command<Project[]>({ method: 'project.list', params: {} })
            .then((projects) => {
              if (version === generation.current) setProjects(projects);
            })
            .catch(() => {});
        }
        unsubscribers.current = [
          candidate.onChange(setSnapshot),
          candidate.onConnection(setConnection),
        ];
        return value;
      } catch (e) {
        candidate?.close();
        if (version !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e));
        if (
          next === 'service' &&
          !current.current &&
          new URLSearchParams(location.search).has('project')
        ) {
          setMode('service');
          setConnection('offline');
          return;
        }
        if (next === 'service' && !current.current) {
          const offline = await replay();
          if (version !== generation.current) {
            offline.close();
            return;
          }
          current.current = offline;
          setClient(offline);
          setSnapshot(await offline.connect());
          setMode('replay');
          setConnection('offline');
          unsubscribers.current = [offline.onChange(setSnapshot)];
        } else setConnection(current.current ? 'connected' : 'offline');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    [],
  );
  useEffect(() => {
    void switchMode(
      new URLSearchParams(location.search).get('source') === 'replay' ? 'replay' : 'service',
    );
    return () => {
      generation.current++;
      for (const u of unsubscribers.current) u();
      current.current?.close();
      current.current = null;
    };
  }, [switchMode]);
  const refreshProjects = useCallback(async () => {
    const source = current.current;
    if (source?.mode === 'service') {
      const projects = await source.command<Project[]>({ method: 'project.list', params: {} });
      if (source === current.current) setProjects(projects);
    }
  }, []);
  const switchProject = useCallback(
    async (id: string) => {
      const value = await switchMode('service', id);
      if (!value) throw Error(t('Could not open the project.'));
      const url = new URL(location.href);
      url.searchParams.set('project', id);
      url.searchParams.delete('source');
      history.replaceState(null, '', url);
    },
    [switchMode],
  );
  return (
    <Context.Provider
      value={{
        snapshot,
        client,
        mode,
        connection,
        error,
        switchMode,
        projects,
        refreshProjects,
        switchProject,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useProject() {
  const value = useContext(Context);
  if (!value) throw Error('ProjectProvider is required.');
  return value;
}
