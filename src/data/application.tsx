import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ApiClient, type ApiConnection } from '../../modules/api/client.ts';
import type { ApiQueries } from '../../modules/api/contract.ts';

const credentialKey = 'buro.local-api-credential';

function browserCredential(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('buro-token');
  if (token) {
    try {
      localStorage.setItem(credentialKey, token);
    } catch {
      /* The current tab still has its credential. */
    }
    fragment.delete('buro-token');
    history.replaceState(
      null,
      '',
      window.location.pathname +
        window.location.search +
        (fragment.size ? '#' + fragment.toString() : ''),
    );
  }
  if (token) return token;
  try {
    return localStorage.getItem(credentialKey) ?? '';
  } catch {
    return '';
  }
}

interface ApplicationContext {
  client: ApiClient;
  revision: number;
  connection: ApiConnection;
  refresh(): void;
}

const context = createContext<ApplicationContext | undefined>(undefined);

/** Shares transport and invalidation, while each feature owns its query data. */
export function ApplicationProvider(input: { children: ReactNode; url?: string }): ReactElement {
  const [token, setToken] = useState(browserCredential);
  const client = useMemo(() => new ApiClient({ url: input.url, token }), [input.url, token]);
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const [connection, setConnection] = useState<ApiConnection>({ connected: false });
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined,
      invalidate: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (active) void client.connect().catch(() => {});
    };
    const offConnection = client.onConnection((state) => {
      if (!active) return;
      setConnection(state);
      clearTimeout(retry);
      if (state.connected) refresh();
      else if (!state.authorizationRequired) retry = setTimeout(connect, 1000);
    });
    const off = client.subscribe((notification) => {
      if (notification.type === 'session.text') return;
      clearTimeout(invalidate);
      invalidate = setTimeout(() => {
        if (active) refresh();
      }, 50);
    });
    const credentialChanged = (event: StorageEvent) => {
      if (event.key === credentialKey) setToken(event.newValue ?? '');
    };
    window.addEventListener('storage', credentialChanged);
    connect();
    return () => {
      active = false;
      clearTimeout(retry);
      clearTimeout(invalidate);
      window.removeEventListener('storage', credentialChanged);
      off();
      offConnection();
      client.close();
    };
  }, [client]);
  return (
    <context.Provider value={{ client, revision, connection, refresh }}>
      {input.children}
    </context.Provider>
  );
}

/** Returns the shared local connection, never a mutable server-state projection. */
export function useApplication(): ApplicationContext {
  const value = useContext(context);
  if (!value) throw new Error('ApplicationProvider is missing.');
  return value;
}

/** One feature read, refreshed from authoritative storage when relevant state changes. */
export interface QueryResult<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

/** Refreshes read operations only; commands cannot accidentally be replayed by this hook. */
export function useApiQuery<K extends keyof ApiQueries>(
  method: K,
  params: ApiQueries[K]['params'] | undefined,
): QueryResult<ApiQueries[K]['result']> {
  const { client, revision } = useApplication();
  const serialized = JSON.stringify(params),
    key = method + ':' + serialized;
  const [state, setState] = useState<QueryResult<ApiQueries[K]['result']> & { key: string }>({
    key,
    loading: params !== undefined,
  });
  useEffect(() => {
    if (serialized === undefined) return;
    let active = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
    }));
    void client.call(method, JSON.parse(serialized)).then(
      (data) => {
        if (active) setState({ key, data: data as ApiQueries[K]['result'], loading: false });
      },
      (error) => {
        if (active)
          setState((previous) => ({
            ...previous,
            key,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [client, method, serialized, revision]);
  return state.key === key ? state : { loading: params !== undefined };
}
