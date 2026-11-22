import {
  RoleTemplateCatalog,
  WorkflowCatalog,
  createWorkflowRoleResolver,
  type RoleTemplate,
} from '../../core/workflow-roles.ts';
import { operationIds } from '../../core/operation-catalog.ts';
const templates: RoleTemplate[] = [
  {
    id: 'developer',
    revision: 'developer-v1',
    kind: 'implementation',
    title: 'Developer',
    description: 'Implements agreed changes.',
    instructions:
      'Implement the assigned task within your owned files. Verify the result and report actual limitations.',
  },
  {
    id: 'test-author',
    revision: 'test-author-v1',
    kind: 'testing',
    title: 'Test author',
    description: 'Independently verifies task requirements.',
    instructions:
      'Write checks from task requirements. Stay independent of the implementation, run the checks and report actual results.',
  },
  {
    id: 'reviewer',
    revision: 'reviewer-v1',
    kind: 'review',
    title: 'Reviewer',
    description: 'Checks result correctness.',
    instructions:
      'Review the changes and actual checks. Return approved or changes_requested with concrete blocking findings. Do not edit sources.',
  },
  {
    id: 'coordinator',
    revision: 'coordinator-v1',
    kind: 'coordination',
    title: 'Coordinator',
    description: 'Understands project context, plans and integrates team work.',
    instructions:
      'Follow the actual service operation. During project research, inspect evidence and propose settings without changing files or executing setup. During goal work, create a plan, assign suitable roles, integrate results and obtain independent acceptance.',
  },
  {
    id: 'local-preview',
    revision: 'local-preview-v1',
    kind: 'general',
    title: 'Local result verification',
    description: 'Prepares a way to inspect a UI, API or another component.',
    instructions:
      'Use the configured project components. Prepare local verification from the result workspace. Do not run migrations or modify shared databases. Do not install packages or perform delivery. The service manages processes, logs and stopping. Report specific missing configuration values.',
  },
  {
    id: 'pull-request',
    revision: 'pull-request-v1',
    kind: 'general',
    title: 'Pull request preparation',
    description: 'Prepares a branch, PR description and check evidence.',
    instructions:
      'Describe the changes in the accepted commit precisely, including checks and limitations. The service creates a separate branch and draft PR only when allowed by project and goal settings. Do not merge, force push or deploy. Delivery retries must reuse the existing PR.',
  },
  {
    id: 'environment-delivery',
    revision: 'environment-delivery-v1',
    kind: 'general',
    title: 'Environment delivery',
    description: 'Coordinates delivery of an accepted commit to staging or production.',
    instructions:
      'Use only the selected, enabled project environment and accepted commit. Verify the delivery plan and result verification method. Do not invent environments, addresses, credentials or commands. Do not run migrations. The service executes operations from saved configuration. Wait for confirmation when required. Command success without an availability check does not mean delivery succeeded. Do not edit sources or automatically retry an ambiguously finished deployment.',
  },
];
export function registerBuiltinRoleTemplates(catalog: RoleTemplateCatalog): void {
  for (const template of templates) catalog.register(template);
}
export function registerBuiltinWorkflows(catalog: WorkflowCatalog): void {
  catalog.register({
    id: 'code',
    revision: 'code-v1',
    templateFor: (operation) => {
      if (operation.id === operationIds.coordination || operation.id === operationIds.research)
        return 'coordinator';
      if (operation.id === operationIds.review) return 'reviewer';
      if (operation.id === operationIds.preview) return 'local-preview';
      if (operation.id === operationIds.pullRequest) return 'pull-request';
      if (operation.purpose === 'delivery' && operation.id.startsWith('result.deploy.'))
        return 'environment-delivery';
      return undefined;
    },
  });
}
export function createBuiltinRoleTemplates(): RoleTemplateCatalog {
  const catalog = new RoleTemplateCatalog();
  registerBuiltinRoleTemplates(catalog);
  return catalog.seal();
}
export function createBuiltinWorkflowRoles() {
  const workflows = new WorkflowCatalog();
  registerBuiltinWorkflows(workflows);
  return createWorkflowRoleResolver({
    templates: createBuiltinRoleTemplates(),
    workflows: workflows.seal(),
    workflowId: 'code',
  });
}
