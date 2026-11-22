import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceCatalog } from '../../../protocol/resources.ts';
import { useProject } from '../../data/provider';

export function useResourceCatalog(projectId?: string) {
  const { client, snapshot, service, connection, resourceGeneration } = useProject();
  const supported =
    !!client &&
    connection === 'connected' &&
    !!(snapshot?.capabilities || service?.capabilities)?.includes('resources.list');
  const canConfigure =
    supported &&
    !!(snapshot?.capabilities || service?.capabilities)?.includes('resources.connection.save');
  const canSetup =
    supported &&
    !!(snapshot?.capabilities || service?.capabilities)?.includes('resources.setup.save');
  const roleRevision = snapshot?.roles
    .map((role) => `${role.id}:${role.version}`)
    .sort()
    .join(',');
  const profileRevision = snapshot?.profile?.revision;
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!supported || !client) return;
    const version = ++generation.current;
    const sourceGeneration = client.getResourceGeneration?.() || 0;
    setLoading(true);
    try {
      const result = await client.command<ResourceCatalog>({
        method: 'resources.list',
        params: projectId ? { projectId } : {},
      });
      if (
        version === generation.current &&
        sourceGeneration === (client.getResourceGeneration?.() || 0)
      ) {
        setCatalog(result);
        setError('');
      }
      return version === generation.current &&
        sourceGeneration === (client.getResourceGeneration?.() || 0)
        ? result
        : undefined;
    } catch (error) {
      if (
        version === generation.current &&
        sourceGeneration === (client.getResourceGeneration?.() || 0)
      )
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [client, supported, projectId, roleRevision, profileRevision, resourceGeneration]);
  useEffect(() => {
    setCatalog(null);
    setError('');
    if (supported) void refresh();
    else setCatalog(null);
    return () => {
      generation.current++;
    };
  }, [refresh, supported]);
  return { client, supported, canConfigure, canSetup, catalog, error, loading, refresh };
}
