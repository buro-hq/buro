import { t } from '../i18n/index.ts';

/** Format service labels; operation identity and eligibility stay service-owned. */
export function operationLabel(label: string) {
  const deployment = 'Prepare deployment: ';
  return label.startsWith(deployment)
    ? t('Prepare deployment: {p0}', { p0: label.slice(deployment.length) })
    : t(label);
}
