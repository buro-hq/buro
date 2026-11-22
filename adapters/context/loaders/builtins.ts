import { ContextLoaderCatalog } from '../../../core/context-loaders.ts';
import { textContextLoader } from './text.ts';
import { imageContextLoader } from './images.ts';
import { documentContextLoader } from './documents.ts';
export function registerBuiltinContextLoaders(catalog: ContextLoaderCatalog) {
  catalog.register(textContextLoader());
  catalog.register(imageContextLoader());
  catalog.register(documentContextLoader());
}
export function createBuiltinContextLoaders() {
  const catalog = new ContextLoaderCatalog();
  registerBuiltinContextLoaders(catalog);
  return catalog.seal();
}
