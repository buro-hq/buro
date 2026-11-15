import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Icon size={30} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
