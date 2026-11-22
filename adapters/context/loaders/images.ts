import type { ContextLoader } from '../../../core/context-loaders.ts';
const formats: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const mime = (name: string) => formats[name.split('.').at(-1)?.toLowerCase() || ''];
export function imageContextLoader(): ContextLoader {
  return {
    id: 'images',
    revision: 'image-reference-v1',
    matches: ({ name }) => !!mime(name),
    async load({ name }) {
      return {
        mimeType: mime(name),
        representation: 'reference',
        note: 'Original image retained. Text-only model requests do not include image pixels.',
      };
    },
  };
}
