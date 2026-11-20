import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceCatalog } from '../../../protocol/resources.ts';
import { useProject } from '../../data/provider';

export function useResourceCatalog() {
  const { client, snapshot, connection } = useProject();
  const supported =
    !!client && connection === 'connected' && !!snapshot?.capabilities.includes('resources.list');
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!supported || !client) return;
    const version = ++generation.current;
    setLoading(true);
    try {
      const result = await client.command<ResourceCatalog>({
        method: 'resources.list',
        params: {},
      });
      if (version === generation.current) {
        setCatalog(result);
        setError('');
      }
      return result;
    } catch (error) {
      if (version === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [client, supported]);
  useEffect(() => {
    if (supported) void refresh();
    else setCatalog(null);
    return () => {
      generation.current++;
    };
  }, [refresh, supported]);
  return { client, supported, catalog, error, loading, refresh };
}
