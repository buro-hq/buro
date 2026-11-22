import { Service, type Context, type Plugin } from 'cordis';
import { ToolContributionCatalog } from '../core/tool-contributions.ts';
import { registerBuiltinRepositoryTools } from '../adapters/tools/builtin-tools.ts';

declare module 'cordis' {
  interface Context {
    toolContributions: ToolContributions;
  }
}

/** Trusted startup tools are sealed before application commands can use their definitions. */
export class ToolContributions extends Service {
  readonly catalog: ToolContributionCatalog;
  constructor(ctx: Context, catalog?: ToolContributionCatalog) {
    super(ctx, 'toolContributions');
    this.catalog = catalog ?? new ToolContributionCatalog();
    if (!catalog) registerBuiltinRepositoryTools(this.catalog);
  }
}
export const toolContributionsPlugin: Plugin.Object<{ catalog?: ToolContributionCatalog }> = {
  name: 'tool-contributions',
  apply(ctx, options) {
    new ToolContributions(ctx, options.catalog);
  },
};
