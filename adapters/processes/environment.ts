import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

export type ProcessEnvironment = { values: Record<string, string>; sources: string[] };
async function readEnvironment(
  root: string,
  id: string,
  componentPath?: string,
): Promise<ProcessEnvironment> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw Error('Invalid environment ID.');
  const realRoot = await fs.realpath(root),
    local = path.join(realRoot, '.buro/local');
  try {
    if ((await fs.lstat(local)).isSymbolicLink()) throw Error('local/ must not be a symlink.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const files: string[] = [];
  if (componentPath !== undefined) {
    const directory = await fs.realpath(path.resolve(realRoot, componentPath));
    if (directory !== realRoot && !directory.startsWith(realRoot + path.sep))
      throw Error('The component escapes the source project.');
    for (const folder of [...new Set([realRoot, directory])])
      files.push(path.join(folder, '.env'), path.join(folder, '.env.local'));
  }
  files.push(path.join(local, 'environment.env'), path.join(local, id + '.env'));
  let values: Record<string, string> = {};
  const sources: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error(`Env file ${path.relative(realRoot, file)} must be a regular file.`);
      if (stat.size > 1024 * 1024)
        throw Error(`Env file ${path.relative(realRoot, file)} exceeds 1 MB.`);
      const parsed = Object.fromEntries(
        Object.entries(parseEnv(await fs.readFile(file, 'utf8'))).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      values = { ...values, ...parsed };
      sources.push(path.relative(realRoot, file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return { values, sources };
}
/** Read existing source dotenv files only for a local preview; never copy values into metadata. */
export const previewEnvironment = (root: string, componentPath: string, id: string) =>
  readEnvironment(root, id, componentPath);
/** Deployment deliberately does not inherit development dotenv files from the repository. */
export const deploymentEnvironment = (root: string, id: string) => readEnvironment(root, id);

const sensitive = /token|secret|password|passwd|credential|private.?key|api.?key|authorization/i;
/** Redact complete values and partial trailing values when stdout splits a secret across chunks. */
export function environmentRedactor(values: Record<string, string>) {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    if (sensitive.test(key)) secrets.add(value);
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value);
        for (const v of [url.username, url.password]) if (v) secrets.add(decodeURIComponent(v));
        for (const [name, v] of url.searchParams) if (v && sensitive.test(name)) secrets.add(v);
      } catch {}
    }
  }
  const variants = [
    ...new Set(
      [...secrets].flatMap((v) => [
        v,
        encodeURIComponent(v),
        new URLSearchParams({ v }).toString().slice(2),
        JSON.stringify(v).slice(1, -1),
      ]),
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const patterns = variants.map((value) => {
    const prefix = new Uint32Array(value.length);
    for (let i = 1, j = 0; i < value.length; i++) {
      while (j && value[i] !== value[j]) j = prefix[j - 1];
      if (value[i] === value[j]) j++;
      prefix[i] = j;
    }
    return { value, prefix };
  });
  if (patterns.some((p) => p.value.length > 30000)) return () => '[redacted]';
  return (text: string) => {
    let output = text;
    for (const { value } of patterns) output = output.replaceAll(value, '[redacted]');
    let trailing = 0;
    for (const { value, prefix } of patterns) {
      let j = 0;
      const start = Math.max(0, output.length - value.length + 1);
      for (let i = start; i < output.length; i++) {
        while (j && output[i] !== value[j]) j = prefix[j - 1];
        if (output[i] === value[j]) j++;
      }
      trailing = Math.max(trailing, j);
    }
    return trailing ? output.slice(0, -trailing) + '[redacted]' : output;
  };
}
