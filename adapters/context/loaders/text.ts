import type { ContextLoader, ContextInput } from '../../../core/context-loaders.ts';
const decode = (input: ContextInput) =>
  new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
export function textContextLoader(): ContextLoader {
  return {
    id: 'text',
    revision: 'utf8-context-v1',
    fallback: true,
    matches(input) {
      try {
        return !decode(input).includes('\0');
      } catch {
        return false;
      }
    },
    async load(input) {
      return {
        mimeType: /\.md$/i.test(input.name) ? 'text/markdown' : 'text/plain',
        representation: 'text',
        text: decode(input),
      };
    },
  };
}
