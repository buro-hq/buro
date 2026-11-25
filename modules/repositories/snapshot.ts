import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeGit } from './git.ts';

const privatePatterns = [
  '**/.buro/**',
  '**/.env',
  '**/.env.*',
  '**/.npmrc',
  '**/.netrc',
  '**/.git-credentials',
  '**/id_rsa',
  '**/id_ed25519',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.codex/**',
  '**/.claude/**',
].map((pattern) => ':(glob,exclude,icase)' + pattern);

/** Captures files through a private index, without changing the workspace's staged changes. */
export async function captureGitTree(input: { workspace: string; base: string }): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-snapshot-'));
  const options = { cwd: input.workspace, indexFile: path.join(directory, 'index') };
  try {
    await safeGit(['read-tree', input.base], options);
    await safeGit(['add', '-A', '--', '.', ...privatePatterns], {
      ...options,
      literalPathspecs: false,
    });
    return (await safeGit(['write-tree'], options)).stdout.trim();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
