import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepositorySegmentEvidence } from '../adapters/tools/segment-evidence.ts';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { assertSegmentScope } from '../core/work-segments.ts';
import type { ToolScope } from '../core/model-ports.ts';
import type { ProjectRegistry } from '../core/ports.ts';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t: any) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-segment-evidence-')),
  );
  const root = path.join(directory, 'source');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const git = (args: string[], cwd = root) => exec('git', args, { cwd, encoding: 'utf8' });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, '.gitignore'), '.buro/\nnode_modules/\n');
  await fs.writeFile(path.join(root, 'src/worker.txt'), 'PUBLIC ORIGINAL WORKER\n');
  await fs.writeFile(path.join(root, 'src/previous.txt'), 'PUBLIC ORIGINAL PREVIOUS\n');
  await fs.writeFile(path.join(root, 'src/remove.txt'), 'PUBLIC REMOVABLE\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'real-check' }, dependencies: { a: '1' } }) + '\n',
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial']);
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root } }) }),
  } as unknown as ProjectRegistry;
  const workspaces = new GitWorkspaces(projects);
  const workspace = await workspaces.prepare('p', 'R-segment');
  const scope: ToolScope = {
    projectId: 'p',
    runId: 'R-segment',
    ownerRunId: 'R-segment',
    sessionId: 'worker-session',
    workspace: workspace.path,
    baseCommit: workspace.base,
    readOnly: false,
    allowedPaths: ['src/worker.txt'],
    protectedPaths: [],
    materials: [],
    commands: [],
  };
  const evidence = new RepositorySegmentEvidence(workspaces);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, git, workspaces, workspace, scope, evidence };
}

test('segment observations are stable, include actual edited/new/deleted bytes, and expose no source text', async (t) => {
  const f = await fixture(t);
  const clean = await f.evidence.inspect(f.scope, signal());
  assert.deepEqual(clean.files, []);
  assert.equal(clean.headCommit, f.workspace.base);
  assert.deepEqual(await f.evidence.inspect(f.scope, signal()), clean);
  await fs.writeFile(
    path.join(f.workspace.path, 'src/worker.txt'),
    'UNIQUE PRIVATE CANDIDATE SOURCE\n',
  );
  await fs.writeFile(path.join(f.workspace.path, 'src/new.txt'), 'UNIQUE NEW CANDIDATE SOURCE\n');
  await fs.unlink(path.join(f.workspace.path, 'src/remove.txt'));
  const changed = await f.evidence.inspect(f.scope, signal());
  assert.notEqual(changed.workspaceFingerprint, clean.workspaceFingerprint);
  assert.deepEqual(
    changed.files.map((entry) => entry.path),
    ['src/new.txt', 'src/remove.txt', 'src/worker.txt'],
  );
  assert.ok(changed.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.fingerprint)));
  assert.doesNotMatch(JSON.stringify(changed), /UNIQUE|PUBLIC|before|after/);
  const previousHash = changed.files.find((entry) => entry.path === 'src/worker.txt')!.fingerprint;
  await fs.writeFile(path.join(f.workspace.path, 'src/worker.txt'), 'DIFFERENT CANDIDATE SOURCE\n');
  const latest = await f.evidence.inspect(f.scope, signal());
  assert.notEqual(
    latest.files.find((entry) => entry.path === 'src/worker.txt')!.fingerprint,
    previousHash,
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/worker.txt'), 'utf8'),
    'PUBLIC ORIGINAL WORKER\n',
  );
});

test('baseline evidence preserves previous specialists and detects both new out-of-scope edits and reverts', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.workspace.path, 'src/previous.txt'),
    'PREVIOUS SPECIALIST FINISHED\n',
  );
  const baseline = await f.evidence.inspect(f.scope, signal());
  await fs.writeFile(
    path.join(f.workspace.path, 'src/worker.txt'),
    'CURRENT SPECIALIST FINISHED\n',
  );
  const valid = await f.evidence.inspect(f.scope, signal());
  assert.doesNotThrow(() => assertSegmentScope(baseline, valid, f.scope));
  await fs.writeFile(
    path.join(f.workspace.path, 'src/previous.txt'),
    'MODIFIED OTHER SPECIALIST\n',
  );
  const changed = await f.evidence.inspect(f.scope, signal());
  assert.throws(() => assertSegmentScope(baseline, changed, f.scope), {
    code: 'SEGMENT_SCOPE_CHANGED',
  });
  await fs.writeFile(path.join(f.workspace.path, 'src/previous.txt'), 'PUBLIC ORIGINAL PREVIOUS\n');
  const reverted = await f.evidence.inspect(f.scope, signal());
  assert.ok(!reverted.files.some((entry) => entry.path === 'src/previous.txt'));
  assert.throws(() => assertSegmentScope(baseline, reverted, f.scope), {
    code: 'SEGMENT_SCOPE_CHANGED',
  });
});

test('mode-only changes are observed even when repository config disables filemode tracking', async (t) => {
  const f = await fixture(t);
  await f.git(['config', 'core.filemode', 'false']);
  const baseline = await f.evidence.inspect(f.scope, signal());
  await fs.chmod(path.join(f.workspace.path, 'src/previous.txt'), 0o755);
  const changed = await f.evidence.inspect(f.scope, signal());
  assert.deepEqual(
    changed.files.map((entry) => entry.path),
    ['src/previous.txt'],
  );
  assert.throws(() => assertSegmentScope(baseline, changed, f.scope), {
    code: 'SEGMENT_SCOPE_CHANGED',
  });
});

test('protected package fields are checked independently while dependency-only changes remain observable', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.workspace.path, 'package.json');
  await fs.writeFile(
    filename,
    JSON.stringify({ scripts: { test: 'real-check' }, dependencies: { a: '2' } }) + '\n',
  );
  const valid = await f.evidence.inspect(f.scope, signal());
  assert.deepEqual(
    valid.files.map((entry) => entry.path),
    ['package.json'],
  );
  await fs.writeFile(
    filename,
    JSON.stringify({ scripts: { test: 'exit 0' }, dependencies: { a: '2' } }) + '\n',
  );
  await assert.rejects(f.evidence.inspect(f.scope, signal()), {
    code: 'SEGMENT_EVIDENCE_UNAVAILABLE',
  });
});

test('segment inspection rejects symlinks and private changed paths without exposing their contents', async (t) => {
  const f = await fixture(t);
  const secret = path.join(f.directory, 'secret');
  await fs.writeFile(secret, 'OUTSIDE PRIVATE CONTENT');
  await fs.unlink(path.join(f.workspace.path, 'src/worker.txt'));
  await fs.symlink(secret, path.join(f.workspace.path, 'src/worker.txt'));
  await assert.rejects(f.evidence.inspect(f.scope, signal()), {
    code: 'SEGMENT_EVIDENCE_UNAVAILABLE',
  });
  await fs.unlink(path.join(f.workspace.path, 'src/worker.txt'));
  await fs.writeFile(path.join(f.workspace.path, 'src/worker.txt'), 'PUBLIC ORIGINAL WORKER\n');
  await fs.writeFile(path.join(f.workspace.path, '.env.local'), 'PRIVATE ENV CONTENT');
  await assert.rejects(f.evidence.inspect(f.scope, signal()), (error: any) => {
    assert.equal(error.code, 'SEGMENT_EVIDENCE_UNAVAILABLE');
    assert.doesNotMatch(error.message, /PRIVATE ENV|OUTSIDE PRIVATE/);
    return true;
  });
  assert.equal(await fs.readFile(secret, 'utf8'), 'OUTSIDE PRIVATE CONTENT');
});

test('Git executable configuration and model-written attributes cannot run during segment observations', async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.directory, 'executed');
  const program = path.join(f.directory, 'sideeffect.sh');
  await fs.writeFile(program, '#!/bin/sh\nprintf executed >> ' + quote(marker) + '\ncat\n', {
    mode: 0o755,
  });
  const hooks = path.join(f.directory, 'hooks');
  await fs.mkdir(hooks);
  await fs.writeFile(
    path.join(hooks, 'post-checkout'),
    '#!/bin/sh\nprintf hook >> ' + quote(marker) + '\n',
    { mode: 0o755 },
  );
  for (const key of [
    'filter.sideeffect.clean',
    'filter.sideeffect.process',
    'diff.sideeffect.command',
    'diff.sideeffect.textconv',
    'diff.external',
    'core.fsmonitor',
  ])
    await f.git(['config', key, quote(program)]);
  await f.git(['config', 'filter.sideeffect.required', 'true']);
  await f.git(['config', 'core.hooksPath', hooks]);
  await fs.writeFile(
    path.join(f.workspace.path, '.gitattributes'),
    '*.txt filter=sideeffect diff=sideeffect\n',
  );
  await fs.writeFile(path.join(f.workspace.path, 'src/worker.txt'), 'SAFE ACTUAL CONTENT\n');
  const changed = await f.evidence.inspect(f.scope, signal());
  assert.ok(changed.files.some((entry) => entry.path === 'src/worker.txt'));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('oversized observations fail closed rather than returning truncated evidence', async (t) => {
  const f = await fixture(t);
  const inspector = new RepositorySegmentEvidence({ changes: async () => [] });
  await Promise.all(
    Array.from({ length: 257 }, (_, index) =>
      fs.writeFile(path.join(f.workspace.path, 'file-' + String(index).padStart(3, '0')), 'x'),
    ),
  );
  await assert.rejects(inspector.inspect(f.scope, signal()), {
    code: 'SEGMENT_EVIDENCE_UNAVAILABLE',
  });
});

test('changed Git identities, unregistered worktrees and cancellation prevent a handoff', async (t) => {
  const f = await fixture(t);
  const unknown = new RepositorySegmentEvidence({
    changes: async () => {
      throw new Error('PRIVATE CHECKPOINT SECRET');
    },
  });
  await assert.rejects(unknown.inspect(f.scope, signal()), (error: any) => {
    assert.equal(error.code, 'SEGMENT_EVIDENCE_UNAVAILABLE');
    assert.doesNotMatch(error.message, /PRIVATE CHECKPOINT/);
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  let inspected = false;
  const cancelled = new RepositorySegmentEvidence({
    changes: async () => {
      inspected = true;
      return [];
    },
  });
  await assert.rejects(cancelled.inspect(f.scope, controller.signal), { name: 'AbortError' });
  assert.equal(inspected, false);
  await f.git(
    ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Unexpected commit'],
    f.workspace.path,
  );
  await assert.rejects(f.evidence.inspect(f.scope, signal()), {
    code: 'SEGMENT_EVIDENCE_UNAVAILABLE',
  });
});

test('inconsistent observations stop before returning a supposedly stable fingerprint', async (t) => {
  const f = await fixture(t);
  let observations = 0;
  const unstable = new RepositorySegmentEvidence({
    changes: async (workspace, base) => {
      if (++observations === 2)
        await fs.writeFile(
          path.join(f.workspace.path, 'src/worker.txt'),
          'CHANGED DURING INSPECTION\n',
        );
      return f.workspaces.changes(workspace, base);
    },
  });
  await assert.rejects(unstable.inspect(f.scope, signal()), {
    code: 'SEGMENT_EVIDENCE_UNAVAILABLE',
  });
});
