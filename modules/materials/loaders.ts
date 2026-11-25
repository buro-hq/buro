import { extractDocument } from './extract-document.ts';
import type { MaterialLoader } from './material.ts';

/** Format adapters preserve a reference when extraction is unavailable; they never claim to analyze absent pixels. */
export function materialLoaders(): MaterialLoader[] {
  const images: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return [
    {
      id: 'documents',
      matches: ({ name }) => /\.(pdf|docx)$/i.test(name),
      async load({ name, bytes, signal }) {
        const pdf = /\.pdf$/i.test(name);
        const mimeType = pdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        try {
          const text = await extractDocument(bytes, pdf ? 'pdf' : 'docx', signal);
          return text.trim()
            ? { mimeType, text }
            : { mimeType, note: 'No text was extracted; the original file is available.' };
        } catch (error) {
          if (signal.aborted) throw error;
          return {
            mimeType,
            note: 'Automatic text extraction is unavailable; the original file is available.',
          };
        }
      },
    },
    {
      id: 'images',
      matches: ({ name }) => !!images[name.split('.').at(-1)?.toLowerCase() ?? ''],
      async load({ name }) {
        return {
          mimeType: images[name.split('.').at(-1)!.toLowerCase()],
          note: 'Original image retained. Text-only model requests do not include image pixels.',
        };
      },
    },
    {
      id: 'text',
      matches({ bytes }) {
        try {
          return !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0');
        } catch {
          return false;
        }
      },
      async load({ name, bytes }) {
        return {
          mimeType: /\.md$/i.test(name) ? 'text/markdown' : 'text/plain',
          text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
      },
    },
  ];
}
