import { ChevronRight } from 'lucide-react';
import { at, clock, type Milestone, type RoleView, type Run } from '../../model';
import { EventIcon as Icon } from '../atoms/EventIcon';

export function EventRow({
  event: m,
  index: i,
  compact = false,
  run,
  roles,
  onInspect: inspect,
}: {
  event: Milestone;
  index: number;
  compact?: boolean;
  run: Run;
  roles: Record<string, RoleView>;
  onInspect: (event: Milestone) => void;
}) {
  return (
    <button
      className={`event-row ${m.failed ? 'event-failed' : ''} ${m.kind === 'accepted' ? 'event-success' : ''} ${compact ? 'compact' : ''}`}
      key={`${m.event.at}-${i}`}
      onClick={() => inspect(m)}
    >
      <span className="event-time mono">{clock(at(run, m.event))}</span>
      <span className={`event-symbol kind-${m.kind}`}>
        <Icon kind={m.kind} />
      </span>
      <span className="event-content">
        <span className="event-title">{m.title}</span>
        <span className="event-description">{m.detail}</span>
      </span>
      <span className="event-actor" style={{ color: roles[m.actor]?.color }}>
        {m.actor}
      </span>
      <ChevronRight size={13} className="event-chevron" />
    </button>
  );
}
