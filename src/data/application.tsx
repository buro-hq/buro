import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ApiClient, type ApiConnection } from '../../modules/api/client.ts';
import type { ApiQueries } from '../../modules/api/contract.ts';
import { queryAffected } from './query-notifications.ts';
import { QuerySubscription, type QueryResult } from './query-subscription.ts';
export type { QueryResult } from './query-subscription.ts';

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

  if (token)
    return token;

  try {
    return localStorage.getItem(credentialKey) ?? '';
  } catch {
    return '';
  }
}

interface ApplicationContext {
  client: ApiClient;
  connection: ApiConnection;
}

const context = createContext<ApplicationContext | undefined>(undefined);

/** Shares the connection while each feature owns its query data and subscriptions. */
export function ApplicationProvider(input: { children: ReactNode; url?: string }): ReactElement {
  const [token, setToken] = useState(browserCredential);
  const client = useMemo(
    () => new ApiClient({
      url: input.url ?? import.meta.env.VITE_BURO_API_URL,
      token,
    }),
    [input.url, token],
  );
  const [connection, setConnection] = useState<ApiConnection>({
    connected: false,
  });
  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (active)
        void client.connect().catch(() => {});
    };
    const offConnection = client.onConnection((state) => {
      if (!active)
        return;

      setConnection(state);
      clearTimeout(retry);
      if (!state.connected && !state.authorizationRequired)
        retry = setTimeout(connect, 1000);
    });
    const credentialChanged = (event: StorageEvent) => {
      if (event.key === credentialKey)
        setToken(event.newValue ?? '');
    };
    window.addEventListener('storage', credentialChanged);
    connect();
    return () => {
      active = false;
      clearTimeout(retry);
      window.removeEventListener('storage', credentialChanged);
      offConnection();
      client.close();
    };
  }, [client]);
  return <context.Provider value={{ client, connection }}>{input.children}</context.Provider>;
}

/** Returns the shared local connection, never a mutable server-state projection. */
export function useApplication(): ApplicationContext {
  const value = useContext(context);
  if (!value)
    throw new Error('ApplicationProvider is missing.');

  return value;
}

/** Refreshes read operations only; commands cannot accidentally be replayed by this hook. */
export function useApiQuery<K extends keyof ApiQueries>(
  method: K,
  params: ApiQueries[K]['params'] | undefined,
): QueryResult<ApiQueries[K]['result']> {
  const { client } = useApplication();
  const serialized = JSON.stringify(params);
  const key = method + ':' + serialized;
  const [state, setState] = useState<QueryResult<ApiQueries[K]['result']> & { key: string }>({
    key,
    loading: params !== undefined,
  });
  useEffect(() => {
    if (serialized === undefined)
      return;

    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
    }));
    const queryParams = JSON.parse(serialized);
    const query = new QuerySubscription<ApiQueries[K]['result']>({
      read: () => client.call(method, queryParams),
      update: (result) => setState({
        key,
        ...result,
      }),
    });
    const off = client.subscribe((notification) => {
      if (queryAffected({
        method,
        params: queryParams,
        notification,
      }))
        query.invalidate();
    });
    const offConnection = client.onConnection((state) => {
      if (state.connected)
        query.invalidate();
    });
    return () => {
      query.close();
      off();
      offConnection();
    };
  }, [client, method, serialized, key]);
  return state.key === key ? state : { loading: params !== undefined };
}
