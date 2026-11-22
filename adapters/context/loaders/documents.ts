import type { ContextLoader } from '../../../core/context-loaders.ts';
import { extractDocument, type DocumentExtractor } from '../extract-document.ts';
const format = (name: string) =>
  /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : undefined;
export function documentContextLoader(extract: DocumentExtractor = extractDocument): ContextLoader {
  return {
    id: 'documents',
    revision: 'document-text-v1',
    matches: ({ name }) => !!format(name),
    async load({ name, bytes }, signal) {
      const kind = format(name)!;
      const mimeType =
        kind === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      try {
        const text = (await extract(bytes, kind, signal)).trim();
        return text
          ? { mimeType, representation: 'text', text }
          : {
              mimeType,
              representation: 'reference',
              note: 'No text was extracted; the original file is available.',
            };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          mimeType,
          representation: 'reference',
          note: 'Automatic text extraction is unavailable; the original file is available.',
        };
      }
    },
  };
}
