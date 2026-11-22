import type { DomainEvent, Run, Agent, Command } from '../../protocol/domain.ts';
import {
  initialRunView,
  mergeRunCurrent,
  mergeRunLifecycle,
  mergeRunWorkspace,
} from '../../protocol/run-view.ts';
type Update<T> = { upsert: T[]; remove: string[] };
type RunDelta = {
  type: 'run.delta';
  runId: string;
  fields: Partial<Run>;
  unset: (keyof Run)[];
  events?: { append?: Run['events']; replace?: Run['events'] };
  agents?: Update<Agent>;
  commands?: Update<Command>;
  goal: Extract<DomainEvent['change'], { type: 'run.changed' }>['goal'];
  roles?: Extract<DomainEvent['change'], { type: 'run.changed' }>['roles'];
};
export type StoredEvent = Omit<DomainEvent, 'change'> & {
  change: DomainEvent['change'] | RunDelta;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function updates<T>(before: T[], after: T[], key: (value: T) => string): Update<T> | undefined {
  const old = new Map(before.map((item) => [key(item), item])),
    ids = new Set(after.map(key));
  const upsert = after.filter((item) => !equal(old.get(key(item)), item)),
    remove = before.map(key).filter((id) => !ids.has(id));
  return upsert.length || remove.length ? { upsert, remove } : undefined;
}
function merge<T>(items: T[], update: Update<T> | undefined, key: (value: T) => string) {
  if (!update) return items;
  const map = new Map(
    items.filter((item) => !update.remove.includes(key(item))).map((item) => [key(item), item]),
  );
  for (const item of update.upsert) map.set(key(item), item);
  return [...map.values()];
}
export function packEvent(event: DomainEvent, previous?: Run): StoredEvent {
  if (event.change.type !== 'run.changed' || !previous) return event;
  const current = event.change.run,
    fields: Partial<Run> = {},
    unset: (keyof Run)[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)] as (keyof Run)[])) {
    if (['events', 'agents', 'commands'].includes(key)) continue;
    if (current[key] === undefined && previous[key] !== undefined) unset.push(key);
    else if (!equal(previous[key], current[key]))
      (fields as Record<string, unknown>)[key] = current[key];
  }
  let events: RunDelta['events'];
  if (!equal(previous.events, current.events))
    events =
      current.events.length >= previous.events.length &&
      previous.events.every((item, i) => equal(item, current.events[i]))
        ? { append: current.events.slice(previous.events.length) }
        : { replace: current.events };
  return {
    ...event,
    change: {
      type: 'run.delta',
      runId: current.id,
      fields,
      unset,
      events,
      agents: updates(previous.agents, current.agents, (a) => a.threadId),
      commands: updates(previous.commands, current.commands, (c) => c.id),
      goal: event.change.goal,
      ...(event.change.roles ? { roles: event.change.roles } : {}),
    },
  };
}
export function expandEvent(event: StoredEvent, runs: Map<string, Run>): DomainEvent {
  const change = event.change;
  if (change.type === 'run.admitted') {
    runs.set(change.current.id, initialRunView(change.current, change.admission, change.view));
    return event as DomainEvent;
  }
  if (change.type === 'run.workspace-bound') {
    const previous = runs.get(change.current.id);
    if (!previous) throw Error('Missing run checkpoint in event log: ' + change.current.id);
    runs.set(
      change.current.id,
      mergeRunWorkspace(previous, change.current, change.binding, change.entry, change.view),
    );
    return event as DomainEvent;
  }
  if (change.type === 'run.cancel-requested' || change.type === 'run.lifecycle-changed') {
    const previous = runs.get(change.current.id);
    if (!previous) throw Error('Missing run checkpoint in event log: ' + change.current.id);
    runs.set(
      change.current.id,
      change.type === 'run.lifecycle-changed'
        ? mergeRunLifecycle(previous, change.current, change.entry, change.view)
        : mergeRunCurrent(previous, change.current),
    );
    return event as DomainEvent;
  }
  if (change.type === 'run.changed') {
    runs.set(change.run.id, change.run);
    return event as DomainEvent;
  }
  if (change.type !== 'run.delta') return event as DomainEvent;
  const previous = runs.get(change.runId);
  if (!previous) throw Error('Missing run checkpoint in event log: ' + change.runId);
  const run = {
    ...previous,
    ...change.fields,
    events: change.events?.replace ?? previous.events.concat(change.events?.append || []),
    agents: merge(previous.agents, change.agents, (a) => a.threadId),
    commands: merge(previous.commands, change.commands, (c) => c.id),
  };
  for (const key of change.unset) delete (run as unknown as Record<string, unknown>)[key];
  if (run.id !== change.runId) throw Error('Run identity changed in event log');
  runs.set(run.id, run);
  return {
    ...event,
    change: {
      type: 'run.changed',
      run,
      goal: change.goal,
      ...(change.roles ? { roles: change.roles } : {}),
    },
  };
}
