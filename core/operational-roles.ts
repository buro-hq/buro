import type { Role } from '../protocol/domain.ts';
const now = '2026-11-10T00:00:00.000Z';
export const operationalRoles: Role[] = [
  {
    id: 'local_preview',
    title: 'Local result verification',
    description: 'Prepares a way to inspect a UI, API or another component.',
    instructions:
      'Use the configured project components. Prepare local verification from the result workspace. Do not run migrations or modify shared databases. Do not install packages or perform delivery. The service manages processes, logs and stopping. Report specific missing configuration values.',
  },
  {
    id: 'delivery_pr',
    title: 'Pull request preparation',
    description: 'Prepares a branch, PR description and check evidence.',
    instructions:
      'Describe the changes in the accepted commit precisely, including checks and limitations. The service creates a separate branch and draft PR only when allowed by project and goal settings. Do not merge, force push or deploy. Delivery retries must reuse the existing PR.',
  },
  {
    id: 'production_delivery',
    title: 'Environment delivery',
    description: 'Coordinates delivery of an accepted commit to staging or production.',
    instructions:
      'Use only the selected, enabled project environment and accepted commit. Verify the delivery plan and result verification method. Do not invent environments, addresses, credentials or commands. Do not run migrations. The service executes operations from saved configuration. Wait for confirmation when required. Command success without an availability check does not mean delivery succeeded. Do not edit sources or automatically retry an ambiguously finished deployment.',
  },
].map((r) => ({ ...r, kind: 'general', version: 1, createdAt: now, updatedAt: now }));
