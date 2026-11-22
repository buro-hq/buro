import { Service, type Context, type Plugin } from 'cordis';
import { ContextLoaderCatalog } from '../core/context-loaders.ts';
import { ProjectAnalysisCatalog } from '../core/project-analysis.ts';
import { CheckRecipeCatalog } from '../core/check-recipes.ts';
import { registerBuiltinContextLoaders } from '../adapters/context/loaders/builtins.ts';
import { registerBuiltinProjectAnalyses } from '../adapters/analysis/project-setup.ts';
import { registerBuiltinCheckRecipes } from '../adapters/discovery/check-recipes/builtins.ts';

declare module 'cordis' {
  interface Context {
    projectContributions: ProjectContributions;
  }
}

/** Installed project extensions supply data; application services retain admission and execution. */
export class ProjectContributions extends Service {
  readonly contextLoaders = new ContextLoaderCatalog();
  readonly analyses = new ProjectAnalysisCatalog();
  readonly checkRecipes = new CheckRecipeCatalog();
  constructor(ctx: Context) {
    super(ctx, 'projectContributions');
    registerBuiltinContextLoaders(this.contextLoaders);
    registerBuiltinProjectAnalyses(this.analyses);
    registerBuiltinCheckRecipes(this.checkRecipes);
  }
  seal() {
    this.contextLoaders.seal();
    this.analyses.seal();
    this.checkRecipes.seal();
  }
}
export const projectContributionsPlugin: Plugin.Object = {
  name: 'project-contributions',
  apply(ctx) {
    new ProjectContributions(ctx);
  },
};
