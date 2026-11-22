import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitWorkspaces } from '../adapters/files/git-workspaces.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { nativeVerificationPolicy } from '../adapters/codex/verification-policy.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { VerificationView } from '../protocol/verification.ts';

const require = createRequire(import.meta.url);
const {
  prepareComparisonFixture,
  canonicalOracle,
  IDENTITY,
} = require('../scripts/lib/model-comparison.cjs');

test('synthetic live checks register their issued immutable view for native review and revoke it on cleanup', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-comparison-verification-')),
  );
  const fixture = await prepareComparisonFixture({ temporaryDirectory: root });
  const project = { id: 'p', name: 'Synthetic comparison', root };
  const owner: {
    id: string;
    workspace?: string;
    baseCommit?: string;
    verificationView?: VerificationView;
  } = { id: 'r' };
  const projects = {
    get: () => ({ snapshot: () => ({ project, runs: [owner] }) }),
  } as unknown as ProjectRegistry;
  const executors = new EnvironmentExecutors();
  const workspaces = new GitWorkspaces(projects);
  const checks = await fixture.createChecks({ projects, executors });
  const signal = new AbortController().signal;
  const workspace = await workspaces.prepare('p', owner.id, 'HEAD');
  owner.workspace = workspace.path;
  owner.baseCommit = workspace.base;
  await executors.register(workspace.path, root, fixture.profile.environment, signal);
  const views: VerificationView[] = [];
  t.after(async () => {
    for (const view of views) {
      await checks.releaseVerificationView?.(view);
      await workspaces.releaseVerificationView(view);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = async () => {
    const revision = await workspaces.captureRevision(workspace.path, workspace.base);
    const view = await workspaces.openVerificationView(workspace.path, revision, {
      projectId: 'p',
      runId: owner.id,
      outputPaths: [],
    });
    owner.verificationView = view;
    views.push(view);
    return view;
  };
  const nativeAccess = (view: VerificationView) =>
    nativeVerificationPolicy(view, executors.verificationPolicy(view), root);

  const baseline = await open();
  assert.throws(() => nativeAccess(baseline), { code: 'VERIFICATION_VIEW_CHANGED' });
  const before = await checks.run('p', workspace.path, ['test'], signal, fixture.profile, {
    requirePreparedIsolation: true,
    verificationView: baseline,
  });
  assert.equal(before.passed, 0);
  assert.equal(before.total, 1);
  await assert.rejects(fs.stat(path.join(baseline.readRoot, '.buro/environment')), {
    code: 'ENOENT',
  });
  assert.ok(nativeAccess(baseline).argument.includes(JSON.stringify(baseline.readRoot)));
  await checks.releaseVerificationView(baseline);
  assert.throws(() => nativeAccess(baseline), { code: 'VERIFICATION_VIEW_CHANGED' });

  await fs.writeFile(
    path.join(workspace.path, 'src/priority.mjs'),
    (await fs.readFile(path.join(workspace.path, 'src/priority.mjs'), 'utf8')).replace(
      '|| 2',
      '?? 2',
    ),
  );
  await fs.writeFile(
    path.join(workspace.path, 'src/queue.mjs'),
    (await fs.readFile(path.join(workspace.path, 'src/queue.mjs'), 'utf8')).replace(
      '.some(',
      '.every(',
    ),
  );
  const fixed = await open();
  assert.notEqual(fixed.tree, baseline.tree);
  const result = await checks.run('p', workspace.path, ['test'], signal, fixture.profile, {
    requirePreparedIsolation: true,
    verificationView: fixed,
  });
  assert.equal(result.passed, 1);
  assert.equal(result.total, 1);
  await assert.rejects(fs.stat(path.join(fixed.readRoot, '.buro/environment')), {
    code: 'ENOENT',
  });
  const policy = nativeAccess(fixed);
  assert.ok(policy.argument.includes(JSON.stringify(fixed.readRoot) + '="read"'));
  assert.ok(policy.argument.includes(JSON.stringify(workspace.path) + '="deny"'));
  assert.ok(policy.argument.includes(JSON.stringify(root) + '="deny"'));

  await assert.rejects(
    checks.run('p', workspace.path, ['test'], signal, fixture.profile, {
      requirePreparedIsolation: true,
      verificationView: { ...fixed, tree: baseline.tree },
    }),
    { code: 'VERIFICATION_VIEW_CHANGED' },
  );
  await assert.rejects(
    checks.run('p', root, ['test'], signal, fixture.profile, {
      requirePreparedIsolation: true,
      verificationView: fixed,
    }),
    { code: 'VERIFICATION_VIEW_CHANGED' },
  );
  const publicResult = await canonicalOracle(fixture, workspace.path, 'public');
  const holdout = await canonicalOracle(fixture, workspace.path, 'holdout');
  assert.equal(publicResult.passed, true);
  assert.equal(holdout.passed, true);
  assert.equal(publicResult.checks, IDENTITY.publicChecks);
  assert.equal(holdout.checks, IDENTITY.holdoutChecks);
  assert.equal(fixture.identity, IDENTITY);

  // Public-script success is insufficient: the controller still owns the expected values.
  await fs.writeFile(
    path.join(workspace.path, 'src/priority.mjs'),
    "import assert from 'node:assert/strict'; assert.equal=()=>{}; assert.deepEqual=()=>{}; export function priorityOf(){return 999;}\n",
  );
  const deceptive = await open();
  const standard = new ProjectChecks(
    projects,
    {
      async run() {
        throw Error('Unexpected fallback');
      },
    },
    executors,
  );
  const publicScript = await standard.run('p', workspace.path, ['test'], signal, fixture.profile, {
    requirePreparedIsolation: true,
    verificationView: deceptive,
  });
  assert.equal(publicScript.passed, 1);
  assert.equal(publicScript.total, 1);
  const independent = await checks.run('p', workspace.path, ['test'], signal, fixture.profile, {
    requirePreparedIsolation: true,
    verificationView: deceptive,
  });
  assert.equal(independent.passed, 0);
  assert.equal(independent.total, 1);
  await assert.rejects(fs.stat(path.join(deceptive.readRoot, '.buro/environment')), {
    code: 'ENOENT',
  });
  await checks.releaseVerificationView(fixed);
  assert.throws(() => nativeAccess(fixed), { code: 'VERIFICATION_VIEW_CHANGED' });
});
