import { Service, type Context, type Plugin } from 'cordis';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import { ProjectAnalysisCatalog } from '../core/project-analysis.ts';
import { CheckRecipeCatalog } from '../core/check-recipes.ts';
import { ExecutionActionCatalog } from '../core/execution-actions.ts';
import { registerBuiltinExecutionActions } from '../adapters/workflows/actions.ts';
import { RoleTemplateCatalog, WorkflowCatalog } from '../core/workflow-roles.ts';
import { registerBuiltinContextLoaders } from '../adapters/context/loaders/builtins.ts';
import { registerBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import { registerBuiltinCheckRecipes } from '../adapters/discovery/check-recipes/builtins.ts';
import {
  registerBuiltinRoleTemplates,
  registerBuiltinWorkflows,
} from '../adapters/workflows/builtins.ts';

declare module 'cordis' {
  interface Context {
    projectContributions: ProjectContributions;
  }
}

/** Installed project extensions supply data; application services retain admission and execution. */
export type ProjectContributionCatalogs = {
  contextLoaders?: ContextLoaderCatalog;
  analyses?: ProjectAnalysisCatalog;
  checkRecipes?: CheckRecipeCatalog;
  roleTemplates?: RoleTemplateCatalog;
  workflows?: WorkflowCatalog;
  actions?: ExecutionActionCatalog;
};
export class ProjectContributions extends Service {
  readonly contextLoaders: ContextLoaderCatalog;
  readonly analyses: ProjectAnalysisCatalog;
  readonly checkRecipes: CheckRecipeCatalog;
  readonly roleTemplates: RoleTemplateCatalog;
  readonly workflows: WorkflowCatalog;
  readonly actions: ExecutionActionCatalog;
  constructor(ctx: Context, catalogs: ProjectContributionCatalogs = {}) {
    super(ctx, 'projectContributions');
    this.contextLoaders = catalogs.contextLoaders ?? new ContextLoaderCatalog();
    this.analyses = catalogs.analyses ?? new ProjectAnalysisCatalog();
    this.checkRecipes = catalogs.checkRecipes ?? new CheckRecipeCatalog();
    this.roleTemplates = catalogs.roleTemplates ?? new RoleTemplateCatalog();
    this.workflows = catalogs.workflows ?? new WorkflowCatalog();
    this.actions = catalogs.actions ?? new ExecutionActionCatalog();
    if (!catalogs.contextLoaders) registerBuiltinContextLoaders(this.contextLoaders);
    if (!catalogs.analyses) registerBuiltinProjectAnalyses(this.analyses);
    if (!catalogs.checkRecipes) registerBuiltinCheckRecipes(this.checkRecipes);
    if (!catalogs.roleTemplates) registerBuiltinRoleTemplates(this.roleTemplates);
    if (!catalogs.workflows) registerBuiltinWorkflows(this.workflows);
    if (!catalogs.actions) registerBuiltinExecutionActions(this.actions);
  }
  seal() {
    this.contextLoaders.seal();
    this.analyses.seal();
    this.checkRecipes.seal();
    this.roleTemplates.seal();
    this.workflows.seal();
    this.actions.seal();
  }
}
export const projectContributionsPlugin: Plugin.Object<ProjectContributionCatalogs> = {
  name: 'project-contributions',
  apply(ctx, catalogs) {
    new ProjectContributions(ctx, catalogs);
  },
};
