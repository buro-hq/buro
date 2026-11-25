import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type DocumentExtractor = (
  bytes: Uint8Array,
  format: 'pdf' | 'docx',
  signal: AbortSignal,
) => Promise<string>;
/** Document tools can only see a private temporary copy of the already authorized bytes. */
export const extractDocument: DocumentExtractor = async (bytes, format, signal): Promise<string> => {
  signal.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-document-'));
  try {
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, 'input.' + format);
    await fs.writeFile(file, bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    const options = { timeout: 30000, maxBuffer: 1024 * 1024, signal };
    if (format === 'pdf') {
      if (process.platform === 'darwin')
        return (
          await exec(
            '/usr/bin/osascript',
            [
              '-l',
              'JavaScript',
              '-e',
              'ObjC.import("PDFKit"); function run(argv) { const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return doc ? ObjC.unwrap(doc.string) || "" : ""; }',
              file,
            ],
            options,
          )
        ).stdout;

      return (await exec('pdftotext', [file, '-'], options)).stdout;
    }

    return (await exec('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], options)).stdout;
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  }
};
