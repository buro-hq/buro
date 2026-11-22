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
  readonly catalog = new ToolContributionCatalog();
  constructor(ctx: Context) {
    super(ctx, 'toolContributions');
    registerBuiltinRepositoryTools(this.catalog);
  }
}
export const toolContributionsPlugin: Plugin.Object = {
  name: 'tool-contributions',
  apply(ctx) {
    new ToolContributions(ctx);
  },
};
