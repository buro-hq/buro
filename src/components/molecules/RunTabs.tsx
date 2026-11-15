import { t } from '../../i18n/index.ts';
import { CheckCheck, GitCompareArrows, History, ListFilter, ShieldCheck } from 'lucide-react';
export type RunTab = 'timeline' | 'plan' | 'changes' | 'checks' | 'result';
const tabs = [
  {
    id: 'timeline',
    get label() {
      return t('Timeline');
    },
    icon: History,
  },
  {
    id: 'plan',
    get label() {
      return t('Plan');
    },
    icon: ListFilter,
  },
  {
    id: 'changes',
    get label() {
      return t('Changes');
    },
    icon: GitCompareArrows,
  },
  {
    id: 'checks',
    get label() {
      return t('Checks');
    },
    icon: ShieldCheck,
  },
  {
    id: 'result',
    get label() {
      return t('Result');
    },
    icon: CheckCheck,
  },
] as const;
export function RunTabs({ value, onChange }: { value: RunTab; onChange: (value: RunTab) => void }) {
  return (
    <div className="run-tabs" role="tablist" aria-label={t('Run details')}>
      {tabs.map((tab) => (
        <button
          role="tab"
          aria-selected={value === tab.id}
          key={tab.id}
          className={value === tab.id ? 'active' : ''}
          onClick={() => onChange(tab.id)}
        >
          <tab.icon size={14} />
          {tab.label}
        </button>
      ))}
    </div>
  );
}
