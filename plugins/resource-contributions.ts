import { Service, type Context, type Plugin } from 'cordis';
import { ResourceContributionCatalog } from '../core/resource-contributions.ts';

declare module 'cordis' {
  interface Context {
    resourceContributions: ResourceContributions;
  }
}

/** Trusted startup plugins register factories before execution resources seal the catalog. */
export class ResourceContributions extends Service {
  readonly catalog: ResourceContributionCatalog;
  constructor(ctx: Context) {
    super(ctx, 'resourceContributions');
    this.catalog = new ResourceContributionCatalog();
  }
}
export const resourceContributionsPlugin: Plugin.Object = {
  name: 'resource-contributions',
  apply(ctx) {
    new ResourceContributions(ctx);
  },
};
