import { useEffect, useRef, useState } from 'react';
import type { SessionHistory } from '../../../modules/sessions/session.ts';
import { useApplication } from '../../data/application.tsx';
import { queryAffected } from '../../data/query-notifications.ts';
import { QuerySubscription, type QueryResult } from '../../data/query-subscription.ts';
import { Transcript } from './transcript.ts';

/** A selected transcript and explicit pagination state, independent of session lists. */
interface HistoryView extends QueryResult<SessionHistory> {
  loadingEarlier: boolean;
  earlier(): Promise<void>;
}

/** Observes new messages and preserves pages explicitly opened by the reader. */
export const useSessionHistory = (input: { sessionId: string }): HistoryView => {
  const { client } = useApplication();
  const { sessionId } = input;
  const [state, setState] = useState<QueryResult<SessionHistory>>({
    loading: true,
  });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlier = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let active = true;
    const transcript = new Transcript({
      sessionId,
      read: (params) => client.call('sessions.messages', params),
    });
    const query = new QuerySubscription({
      read: () => transcript.refresh(),
      update: setState,
    });
    const off = client.subscribe((notification) => {
      if (queryAffected({
        method: 'sessions.messages',
        params: { sessionId },
        notification,
      }))
        query.invalidate();
    });
    const offConnection = client.onConnection(({ connected }) => {
      if (connected)
        query.invalidate();
    });
    let readingEarlier = false;
    earlier.current = async () => {
      if (readingEarlier)
        return;

      readingEarlier = true;
      setLoadingEarlier(true);
      try {
        const data = await transcript.earlier();

        if (active)
          setState({
            data,
            loading: false,
          });
      } catch (error) {
        if (active)
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        readingEarlier = false;

        if (active)
          setLoadingEarlier(false);
      }
    };

    return () => {
      active = false;
      query.close();
      off();
      offConnection();
    };
  }, [client, sessionId]);

  return { ...state, loadingEarlier, earlier: () => earlier.current() };
};
