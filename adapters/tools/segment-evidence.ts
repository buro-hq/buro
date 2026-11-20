import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkspacePort } from '../../core/execution-ports.ts';
import type { ToolScope } from '../../core/model-ports.ts';
import { dependencyManifestPreserved } from '../../core/environment-repair.ts';
import { DomainError } from '../../core/ports.ts';
import type { SegmentEvidence, SegmentEvidencePort } from '../../core/work-segments.ts';
import { safeGit } from '../processes/safe-git.ts';

const maxFiles = 256;
const maxFileBytes = 1024 * 1024;
const maxTotalBytes = 32 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const metadata = (file: string) =>
  ['.buro', 'node_modules'].some(
    (directory) => file === directory || file.startsWith(directory + '/'),
  );
const privatePath = (file: string) =>
  file
    .split('/')
    .some(
      (part) =>
        [
          '.git',
          '.codex',
          '.claude',
          '.aws',
          '.ssh',
          '.npmrc',
          '.netrc',
          '.git-credentials',
          'id_rsa',
          'id_ed25519',
        ].includes(part) ||
        (part.startsWith('.env') && part !== '.env.example') ||
        /\.(pem|key|p12|pfx|keystore)$/i.test(part),
    );

function unavailable(message: string): never {
  throw new DomainError('SEGMENT_EVIDENCE_UNAVAILABLE', message);
}

/** Hash actual, validated worktree state without trusting a model's summary or executing its code. */
export class RepositorySegmentEvidence implements SegmentEvidencePort {
  private workspaces: Pick<WorkspacePort, 'changes'>;
  constructor(workspaces: Pick<WorkspacePort, 'changes'>) {
    this.workspaces = workspaces;
  }

  async inspect(scope: ToolScope, signal: AbortSignal): Promise<SegmentEvidence> {
    signal.throwIfAborted();
    try {
      // Two complete observations catch unstable files, modes, paths and Git identity.
      const before = await this.observe(scope, signal);
      const after = await this.observe(scope, signal);
      if (before.workspaceFingerprint !== after.workspaceFingerprint)
        unavailable('The workspace changed during segment inspection.');
      return after;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DomainError && error.code === 'SEGMENT_EVIDENCE_UNAVAILABLE')
        throw error;
      unavailable('The workspace could not be independently verified for a new segment.');
    }
  }

  private async observe(scope: ToolScope, signal: AbortSignal): Promise<SegmentEvidence> {
    const baseCommit = scope.baseCommit;
    if (!baseCommit || !/^[a-f0-9]{40,64}$/.test(baseCommit))
      unavailable('A segment requires its saved Git base.');
    const workspace = path.resolve(scope.workspace);
    if (
      (await fs.realpath(workspace)) !== workspace ||
      (await fs.lstat(workspace)).isSymbolicLink()
    )
      unavailable('The workspace identity changed.');

    // This existing port validates the registered worktree and its saved Git control files.
    const changes = await this.workspaces.changes(workspace, baseCommit);
    signal.throwIfAborted();
    if (!dependencyManifestPreserved(changes))
      unavailable('Protected package fields or check commands changed.');

    const gitOptions = { cwd: workspace, signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 };
    const headCommit = (await safeGit(['rev-parse', '--verify', 'HEAD'], gitOptions)).stdout.trim();
    if (headCommit !== baseCommit) unavailable('The workspace Git base changed.');
    const tracked = (
      await safeGit(
        [
          '-c',
          'core.filemode=true',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          baseCommit,
          '--',
        ],
        gitOptions,
      )
    ).stdout.split('\0');
    const untracked = (
      await safeGit(['ls-files', '--others', '--exclude-standard', '-z'], gitOptions)
    ).stdout.split('\0');
    const names = [...new Set([...changes.map((change) => change.path), ...tracked, ...untracked])]
      .filter((file) => file && !metadata(file))
      .sort();
    if (names.length > maxFiles) unavailable('The workspace exceeds bounded segment inspection.');

    const files: SegmentEvidence['files'] = [];
    let bytes = 0;
    for (const file of names) {
      signal.throwIfAborted();
      if (
        file.length > 1000 ||
        path.isAbsolute(file) ||
        file.includes('\\') ||
        file.split('/').some((part) => !part || part === '.' || part === '..') ||
        privatePath(file)
      )
        unavailable('A changed file is not a public workspace path.');
      const observed = await this.file(workspace, file, signal);
      bytes += observed.bytes;
      if (bytes > maxTotalBytes) unavailable('The workspace exceeds bounded segment inspection.');
      files.push({ path: file, fingerprint: observed.fingerprint });
    }
    signal.throwIfAborted();
    return {
      version: 1,
      baseCommit,
      headCommit,
      workspaceFingerprint: hash(JSON.stringify([workspace, baseCommit, headCommit, files])),
      files,
    };
  }

  private async file(workspace: string, file: string, signal: AbortSignal) {
    let filename = workspace;
    const parts = file.split('/');
    for (let index = 0; index < parts.length; index++) {
      filename = path.join(filename, parts[index]);
      let stat;
      try {
        stat = await fs.lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { bytes: 0, fingerprint: hash(JSON.stringify(['deleted'])) };
        throw error;
      }
      if (stat.isSymbolicLink())
        unavailable('Segment inspection does not follow changed symlinks.');
      if (index < parts.length - 1) {
        if (!stat.isDirectory()) unavailable('A workspace ancestor changed.');
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes)
        unavailable('A changed file exceeds bounded regular-file inspection.');
      const handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat();
        const current = await fs.lstat(filename);
        if (
          !opened.isFile() ||
          opened.size > maxFileBytes ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.isSymbolicLink() ||
          (await fs.realpath(filename)) !== filename
        )
          unavailable('A workspace file changed while being inspected.');
        signal.throwIfAborted();
        const content = await handle.readFile();
        if (content.length > maxFileBytes)
          unavailable('A changed file exceeds bounded regular-file inspection.');
        const finished = await handle.stat();
        if (
          finished.size !== opened.size ||
          finished.mtimeMs !== opened.mtimeMs ||
          finished.mode !== opened.mode
        )
          unavailable('A workspace file changed while being inspected.');
        return {
          bytes: content.length,
          fingerprint: hash(JSON.stringify(['file', opened.mode & 0o777, hash(content)])),
        };
      } finally {
        await handle.close();
      }
    }
    return unavailable('A workspace file could not be inspected.');
  }
}
