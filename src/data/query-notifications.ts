import type { ApiQueries } from '../../modules/api/contract.ts';
import type { Notification } from '../../modules/events/notifications.ts';

const topics: Record<keyof ApiQueries, readonly string[]> = {
  'presets.list': ['preset'],
  'presets.get': ['preset'],
  'projects.list': ['project'],
  'projects.get': ['project'],
  'previews.list': ['preview'],
  'previews.get': ['preview'],
  'deliveries.list': ['delivery'],
  'deliveries.publishers': [],
  'tasks.list': ['task'],
  'tasks.get': ['task'],
  'runs.list': ['run'],
  'runs.get': ['run'],
  'results.inspect': ['run', 'session', 'result'],
  'materials.list': ['material'],
  'materials.read': ['material'],
  'materials.download': ['material'],
  'sessions.list': ['session'],
  'sessions.get': ['session'],
  'sessions.messages': ['session'],
  'activity.list': ['session', 'run'],
  'agents.list': ['agent'],
  'models.list': ['model'],
  'models.transports': [],
  'models.discover': ['model'],
  'settings.get': ['settings'],
};

/** Refreshes only affected feature reads; missing owner metadata keeps deletion visible. */
export const queryAffected = (input: {
  method: keyof ApiQueries;
  params: object;
  notification: Notification;
}): boolean => {
  const { method, params, notification } = input;
  const isProvisional = ['session.text', 'session.retry'].includes(notification.type);
  if (isProvisional)
    return false;

  const readsMessages = method === 'sessions.messages';
  const messagesChanged = ['session.messages', 'session.deleted'].includes(notification.type);
  if (readsMessages && !messagesChanged)
    return false;

  const topic = notification.type.split('.')[0];
  if (!topics[method].includes(topic))
    return false;

  const data = notification.data as Record<string, unknown> | undefined;
  const hasMetadata = data && typeof data === 'object';
  if (!hasMetadata)
    return true;

  for (const [key, value] of Object.entries(params)) {
    if (!['id', 'runId', 'sessionId', 'taskId', 'projectId'].includes(key))
      continue;

    // Tasks may move between projects; both the old and new lists must refresh.
    const taskMayHaveMoved = method === 'tasks.list' && notification.type === 'task.updated';
    if (taskMayHaveMoved)
      continue;

    const refersToRun = key === 'runId' && topic === 'run';
    const refersToSession = key === 'sessionId' && topic === 'session';
    const ownerKey = refersToRun || refersToSession ? 'id' : key;
    const observedOwner = data[ownerKey];
    const hasDifferentOwner = observedOwner !== undefined && observedOwner !== value;
    if (hasDifferentOwner)
      return false;
  }
  return true;
};
