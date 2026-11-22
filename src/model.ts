import { roleLabels } from './ui/role-labels.ts';
import { t } from './i18n/index.ts';
import { agentIntervals, wallDuration } from '../protocol/timing.ts';
import type { Agent, Command, RunEvent as Event, Role, Run } from '../protocol/domain.ts';
export type {
  Agent,
  Check,
  Command,
  RunEvent as Event,
  FileChange,
  Run,
} from '../protocol/domain.ts';
export type RoleView = {
  title: string;
  description: string;
  color: string;
  letter: string;
  owns: string;
  definition?: Role;
};
export const roleColor = (kind?: Role['kind']) => `var(--role-${kind || 'general'})`;
export function roleViewsForRun(catalog: Role[], run: Run): Record<string, RoleView> {
  const views: Record<string, RoleView> = {};
  for (const id of new Set([
    ...catalog.map((r) => r.id),
    ...run.agents.map((a) => a.name),
    ...(run.resultAgents || []).map((a) => a.name),
    'coordinator',
  ])) {
    const role = run.roleSnapshots?.find((r) => r.id === id) || catalog.find((r) => r.id === id),
      agent = run.agents.find((a) => a.name === id);
    const labels = role ? roleLabels(role) : undefined;
    const title = labels?.title || id;
    views[id] = {
      title,
      description: labels?.description || t('Task specialist'),
      color: roleColor(role?.kind),
      letter: title.slice(0, 1),
      owns:
        agent?.assignment?.paths.join(', ') ||
        (role?.kind === 'review'
          ? t('Code review')
          : role?.kind === 'coordination'
            ? t('Goal coordination')
            : t('Current task files')),
      definition: role,
    };
  }
  return views;
}
/** An opened session describes the role version it actually used, including result preparation. */
export function roleViewForAgent(run: Run, agent: Agent, fallback?: RoleView): RoleView {
  const definition = agent.session
    ? run.roleSnapshots?.find(
        (role) => role.id === agent.session!.roleId && role.version === agent.session!.roleVersion,
      )
    : fallback?.definition;
  const labels = definition ? roleLabels(definition) : undefined;
  const title = labels?.title || (agent.session ? agent.name : fallback?.title) || agent.name;
  return {
    title,
    description:
      labels?.description ||
      (agent.session ? undefined : fallback?.description) ||
      t('Task specialist'),
    color: roleColor(definition?.kind),
    letter: title.slice(0, 1),
    owns: agent.assignment?.paths.join(', ') || fallback?.owns || t('Current task files'),
    definition,
  };
}
export const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
export const isTerminal = (r: Run) =>
  !r.status || ['completed', 'failed', 'interrupted', 'needs-attention'].includes(r.status);
export const duration = wallDuration;
export function clock(value: number) {
  const n = Math.max(0, Math.round(value));
  const minutes = `${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return n >= 3600 ? `${Math.floor(n / 3600)}:${minutes}` : minutes;
}
export const at = (r: Run, e: Event) => seconds(r.createdAt, e.at);
export const owner = (r: Run, id?: string) =>
  id === r.threadId
    ? 'coordinator'
    : r.agents.find((a) => a.threadId === id)?.name || 'coordinator';
export const eventsAt = (r: Run, time: number) => r.events.filter((e) => at(r, e) <= time + 0.01);
export function commandFor(r: Run, e: Event) {
  return e.commandId
    ? r.commands.find((c) => c.id === e.commandId)
    : r.commands.find(
        (c) =>
          c.threadId === e.threadId && Math.abs(seconds(e.at, c.completedAt || c.startedAt)) < 0.1,
      );
}
export function isTest(c?: Command) {
  return (
    !!c && /\b(?:node\s+--test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)(?:\s|$)/.test(c.command)
  );
}
export function counts(output = '') {
  const val = (name: string) =>
    Number(output.match(new RegExp(`(?:ℹ|#) ${name} (\\d+)`))?.[1] || 0);
  return { total: val('tests'), passed: val('pass'), failed: val('fail') };
}
export function lastTest(r: Run, time: number) {
  return r.commands
    .filter((c) => isTest(c) && c.completedAt && seconds(r.createdAt, c.completedAt) <= time)
    .at(-1);
}
export function agentState(r: Run, a: Agent, time: number): 'waiting' | 'working' | 'done' {
  const intervals = agentIntervals(r, a);
  if (
    intervals.some(
      (interval) => time >= interval.start && (time < interval.end - 0.001 || interval.open),
    )
  )
    return 'working';
  return time >= (intervals[0]?.start ?? seconds(r.createdAt, a.startedAt)) ? 'done' : 'waiting';
}
export function phase(r: Run, time: number) {
  if (!isTerminal(r) && time >= duration(r) - 0.05)
    return {
      preparing: t('Preparing'),
      queued: t('Queued'),
      planning: t('Planning'),
      implementation: t('Implementation'),
      checking: t('Checks'),
      review: t('Review'),
      repair: t('Repair'),
      done: t('Finishing'),
    }[r.phase || 'queued'];
  if (time >= duration(r) - 0.05)
    return r.status === 'failed'
      ? t('Failed')
      : r.status === 'interrupted'
        ? t('Interrupted')
        : r.status === 'needs-attention'
          ? t('Needs attention')
          : t('Accepted');
  const observed = r.events
    .filter((event) => event.type.startsWith('phase.') && seconds(r.createdAt, event.at) <= time)
    .at(-1);
  const labels: Record<string, string> = {
    preparing: t('Preparing'),
    queued: t('Queued'),
    planning: t('Planning'),
    implementation: t('Implementation'),
    checking: t('Checks'),
    review: t('Review'),
    repair: t('Repair'),
    done: t('Finishing'),
  };
  return observed
    ? labels[observed.type.slice('phase.'.length)] || t('Implementation')
    : t('Preparing');
}
export type Milestone = {
  event: Event;
  kind:
    | 'plan'
    | 'agent'
    | 'file'
    | 'test'
    | 'finding'
    | 'review'
    | 'accepted'
    | 'system'
    | 'command'
    | 'message';
  title: string;
  detail: string;
  actor: string;
  failed?: boolean;
  command?: Command;
};
export function milestone(r: Run, e: Event, roles = roleViewsForRun([], r)): Milestone | null {
  const actor = owner(r, e.threadId),
    detail = e.text || '',
    command = commandFor(r, e);
  const base = { event: e, actor, detail, command };
  if (e.type === 'thread.started')
    return {
      ...base,
      kind: 'system',
      title: t('Goal started'),
      detail: t('Separate coordinator session · planning before execution'),
    };
  if (e.type === 'plan.rejected')
    return { ...base, kind: 'finding', failed: true, title: t('Plan needs revision') };
  if (e.type === 'plan.saved')
    return {
      ...base,
      kind: 'plan',
      title: t('Plan saved'),
      detail: t('{p0} steps · roles assigned · file ownership divided between workers', {
        p0: r.plan.length,
      }),
    };
  if (e.type === 'agent.started' || e.type === 'agent.turn-started')
    return {
      ...base,
      kind: 'agent',
      title:
        e.type === 'agent.turn-started'
          ? t('Agent resumed work')
          : actor === 'reviewer'
            ? t('Independent reviewer joined')
            : t('Started {p0}', { p0: roles[actor]?.title.toLowerCase() || actor }),
      detail:
        actor === 'reviewer'
          ? t('New session · checking code and actual test results')
          : roles[actor]?.owns || detail,
    };
  if (e.type === 'files.changed')
    return {
      ...base,
      kind: 'file',
      title: t('Changes saved'),
      detail: detail
        .split(', ')
        .map((p) => p.split('/improvements/cli/')[1] || p)
        .join(', '),
    };
  if (e.type === 'command.completed' && isTest(command)) {
    const c = counts(command?.output);
    return {
      ...base,
      kind: 'test',
      title: c.failed
        ? t('{p0} checks failed', { p0: c.failed })
        : t('Tests passed: {p0}/{p1}', { p0: c.passed, p1: c.total }),
      detail: c.failed ? t('Repair required before acceptance') : t('Saved test command output'),
      failed: !!c.failed,
    };
  }
  if (e.type === 'message' && actor === 'reviewer') {
    const failed = /blocking|\u0431\u043b\u043e\u043a\u0438\u0440\u0443\u044e\u0449|P1|P2/.test(
      detail,
    );
    return {
      ...base,
      kind: failed ? 'finding' : 'review',
      title: failed ? t('Review: changes requested') : t('Reviewer feedback'),
      detail,
      failed,
    };
  }
  if (e.type === 'acceptance')
    return {
      ...base,
      kind: 'accepted',
      title: t('Independent acceptance: {p0}/{p1}', {
        p0: r.acceptance.passed,
        p1: r.acceptance.total,
      }),
      detail: t('Separate checks outside agent workspaces'),
    };
  if (e.type === 'goal.completed')
    return {
      ...base,
      kind: 'accepted',
      title: t('Goal completed and accepted'),
      detail: t('Change boundaries respected · task and instructions preserved'),
    };
  if (
    e.type.startsWith('phase.') ||
    e.type.startsWith('role.') ||
    e.type.startsWith('runtime.') ||
    e.type.startsWith('environment.') ||
    e.type.startsWith('run.') ||
    e.type === 'checks.completed' ||
    e.type === 'review.completed'
  )
    return {
      ...base,
      kind:
        e.type === 'checks.completed'
          ? 'test'
          : e.type === 'review.completed'
            ? 'review'
            : 'system',
      title: detail.split('\n')[0].slice(0, 180),
      failed: e.type === 'run.failed' || e.type === 'run.interrupted',
    };
  return null;
}
export function allMilestones(
  r: Run,
  time: number,
  all = false,
  roles = roleViewsForRun([], r),
): Milestone[] {
  return eventsAt(r, time).flatMap((e) => {
    const m = milestone(r, e, roles);
    if (m) return [m];
    if (!all) return [];
    if (e.type === 'command.completed')
      return [
        {
          event: e,
          actor: owner(r, e.threadId),
          detail: commandFor(r, e)?.command || e.text || '',
          command: commandFor(r, e),
          kind: 'command' as const,
          title: t('Command completed'),
          failed: (commandFor(r, e)?.exitCode || 0) !== 0,
        },
      ];
    if (e.type === 'message')
      return [
        {
          event: e,
          actor: owner(r, e.threadId),
          detail: e.text || '',
          kind: 'message' as const,
          title: t('Agent message'),
        },
      ];
    return [];
  });
}
export type DiffLine = {
  kind: 'add' | 'remove' | 'same';
  text: string;
  old?: number;
  next?: number;
};
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n'),
    b = after.split('\n');
  if (!before) a.length = 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], old: ++i, next: ++j });
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ kind: 'add', text: b[j], next: ++j });
    } else {
      out.push({ kind: 'remove', text: a[i], old: ++i });
    }
  }
  return out;
}
