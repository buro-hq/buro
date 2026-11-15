import { t } from '../../i18n/index.ts';
import type { ReactNode } from 'react';
export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'error' | 'success';
}) {
  return (
    <div
      className={`notice notice-${tone} ${tone === 'error' ? 'form-error' : tone === 'warning' ? 'source-notice' : ''}`}
      role={tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined}
    >
      {typeof children === 'string' ? t(children) : children}
    </div>
  );
}
