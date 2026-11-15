import { Code2, Network, ShieldCheck, SquareTerminal, Users } from 'lucide-react';
import type { RoleKind } from '../../../protocol/domain.ts';
const icons = {
  implementation: Code2,
  testing: SquareTerminal,
  review: ShieldCheck,
  coordination: Network,
  general: Users,
};
export function RoleIcon({ kind = 'general', size = 21 }: { kind?: RoleKind; size?: number }) {
  const Icon = icons[kind];
  return <Icon size={size} />;
}
