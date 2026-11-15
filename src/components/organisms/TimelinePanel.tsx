import { useLocale, t } from '../../i18n/index.ts';
import { ActionIcon, Select, TextInput, Tooltip } from '@mantine/core';
import { ListFilter, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { allMilestones, type Milestone, type RoleView, type Run } from '../../model';

import { EventRow } from '../molecules/EventRow';
import { ParallelChart } from '../molecules/ParallelChart';

export function TimelinePanel({
  run,
  cursor,
  roles,
  onAgent: setAgentDetail,
  onInspect: inspect,
}: {
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
  onAgent: (id: string) => void;
  onInspect: (event: Milestone) => void;
}) {
  const locale = useLocale();
  const [search, setSearch] = useState(''),
    [all, setAll] = useState(false),
    [actorFilter, setActorFilter] = useState<string | null>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const milestones = useMemo(
    () => allMilestones(run, cursor, all, roles),
    [run, cursor, all, roles, locale],
  );
  const filtered = milestones.filter(
    (m) =>
      (actorFilter === 'all' || m.actor === actorFilter) &&
      `${m.title} ${m.detail} ${m.actor}`.toLowerCase().includes(search.toLowerCase()),
  );
  const eventRow = (m: Milestone, i: number) => (
    <EventRow key={i} event={m} index={i} run={run} roles={roles} onInspect={inspect} />
  );
  return (
    <>
      <div className="section-heading timeline-heading">
        <div>
          <h2>{t('Activity')}</h2>
          <p className="caption">{t('Coordinator and child session events in one place')}</p>
        </div>
        <span className="mono micro">
          {filtered.length} {t('EVENTS')}
        </span>
      </div>
      <ParallelChart roles={roles} run={run} cursor={cursor} onAgent={setAgentDetail} />
      <div className="timeline-toolbar">
        <TextInput
          ref={searchRef}
          aria-label={t('Search events')}
          placeholder={t('Find an event or command…')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          leftSection={<Search size={14} />}
          rightSection={<span className="keycap">/</span>}
          size="xs"
        />
        <Select
          aria-label={t('Filter by agent')}
          value={actorFilter}
          onChange={setActorFilter}
          data={[
            { value: 'all', label: t('All agents') },
            ...Object.entries(roles).map(([v, r]) => ({ value: v, label: r.title })),
          ]}
          size="xs"
          allowDeselect={false}
        />
        <Tooltip label={t('Show commands and messages')}>
          <ActionIcon
            variant={all ? 'light' : 'subtle'}
            color="gray"
            onClick={() => setAll(!all)}
            aria-label={t('All events')}
            aria-pressed={all}
          >
            <ListFilter size={16} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className="timeline-events">
        {filtered.map((m, i) => eventRow(m, i))}
        {!filtered.length && (
          <div className="empty">
            <Search size={24} />
            <h3>{t('Nothing here yet')}</h3>
            <p>{search ? t('Change the query or filter.') : t('No events at this point yet.')}</p>
          </div>
        )}
      </div>
    </>
  );
}
