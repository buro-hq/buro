import { t } from '../../i18n/index.ts';
import { Badge } from '@mantine/core';
import { Check, ChevronDown, FileText } from 'lucide-react';
import { useState } from 'react';
import { getRunViewState } from '../../features/runs/view-model';
import { type RoleView, type Run } from '../../model';

export function PlanPanel({
  run,
  cursor,
  roles,
}: {
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
}) {
  const { complete } = getRunViewState(run, cursor);
  const [planStep, setPlanStep] = useState<number | null>(null);
  return (
    <div className="content-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Plan and task boundaries')}</h2>
          <p className="caption">{t('Saved before workers start · separate turn')}</p>
        </div>
        <Badge color="sage" variant="light">
          {run.plan.length} {t('steps')}
        </Badge>
      </div>
      <div className="plan-steps">
        {run.plan.map((step, i) => (
          <button
            key={i}
            className={`plan-step ${planStep === i ? 'expanded' : ''}`}
            onClick={() => setPlanStep(planStep === i ? null : i)}
          >
            <span className="step-number">
              {complete ? <Check size={15} /> : String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <span className="micro" style={{ color: roles[step.owner]?.color }}>
                {roles[step.owner]?.title || step.owner}
              </span>
              <p>{step.step}</p>
              {planStep === i && (
                <span className="plan-extra">
                  {t('Owner:')} {step.owner} · {roles[step.owner]?.owns}
                </span>
              )}
            </div>
            <ChevronDown size={15} />
          </button>
        ))}
      </div>
      <details className="spec-details">
        <summary>
          <FileText size={15} /> {t('Original task')} <ChevronDown size={14} />
        </summary>
        <pre>{run.goalText}</pre>
        {!!run.contextMaterials?.length && (
          <div style={{ padding: 16 }}>
            <p className="caption">{t('Materials used in this run · saved copies')}</p>
            {run.contextMaterials.map((m) => (
              <p key={m.id} className="caption" style={{ overflowWrap: 'anywhere' }}>
                {m.name} · {m.hash.slice(0, 8)}
              </p>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
