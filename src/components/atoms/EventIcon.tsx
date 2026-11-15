import {
  Check,
  FileCode2,
  ListFilter,
  MessageSquare,
  ShieldCheck,
  SquareTerminal,
  Target,
  Users,
} from 'lucide-react';
import { type Milestone } from '../../model';
export const EventIcon = ({ kind, size = 15 }: { kind: Milestone['kind']; size?: number }) => {
  const Comp = {
    plan: ListFilter,
    agent: Users,
    file: FileCode2,
    test: SquareTerminal,
    finding: MessageSquare,
    review: ShieldCheck,
    accepted: Check,
    system: Target,
    command: SquareTerminal,
    message: MessageSquare,
  }[kind];
  return <Comp size={size} />;
};
