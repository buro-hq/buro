import { CheckRecipeCatalog } from '../../../core/check-recipes.ts';
import { nodeCheckRecipe } from './node.ts';

export function registerBuiltinCheckRecipes(catalog: CheckRecipeCatalog) {
  catalog.register(nodeCheckRecipe());
}
/** Standalone adapter default; application core never imports this composition. */
export function createBuiltinCheckRecipes() {
  const catalog = new CheckRecipeCatalog();
  registerBuiltinCheckRecipes(catalog);
  return catalog.seal();
}
