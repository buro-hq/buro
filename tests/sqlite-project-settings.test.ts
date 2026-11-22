import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteProjectUsageAuthority } from '../adapters/sqlite/project-usage-authority.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import type { Project, ProjectProfile, ProjectVerification } from '../protocol/domain.ts';
import type { SettingsTransaction } from '../core/project-settings.ts';

const command = (id: string) => ({ id, fingerprint: id });
const profile = (revision = 1, context = 'Authoritative context'): ProjectProfile =>
  ProjectProfileSchema.parse({
    version: 1,
    revision,
    context,
    scope: { mode: 'advisory', plannedPaths: [], protectedPaths: [] },
    checks: [],
    defaultCheckIds: [],
    setup: [],
    dependencies: 'none',
    maxWorkers: 1,
    turnTimeoutMs: 10000,
    baseBranch: 'main',
  });
const verification = (profileRevision = 1): ProjectVerification => ({
  id: 'verification',
  profileRevision,
  createdAt: 'now',
  workspace: 'synthetic-workspace',
  base: 'a'.repeat(40),
  passed: 1,
  total: 1,
  results: [{ name: 'Synthetic check', passed: true }],
});
async function fixture(t: any, initial: ProjectProfile | null = profile()) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-sql-settings-')),
  );
  const project: Project = {
    id: 'p',
    name: 'Saved project name',
    root: path.join(directory, 'source'),
    managed: true,
    dataDirectory: path.join(directory, 'metadata'),
  };
  const opened: SqliteProjectUsageAuthority[] = [];
  const open = async (
    input: Partial<Parameters<typeof SqliteProjectUsageAuthority.open>[0]> = {},
  ) => {
    const authority = await SqliteProjectUsageAuthority.open({
      directory,
      project,
      profile: initial ?? undefined,
      ...input,
    });
    opened.push(authority);
    return authority;
  };
  t.after(async () => {
    await Promise.all(opened.map((authority) => authority.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, project, open, authority: await open() };
}

test('project and profile bootstrap are captured once and saved values win on reopen', async (t) => {
  const f = await fixture(t);
  await f.authority.close();
  const bootstrapProject = { ...f.project, name: 'Untrusted reopened name' };
  const bootstrapProfile = profile(99, 'Untrusted reopened profile');
  const opening = f.open({ project: bootstrapProject, profile: bootstrapProfile });
  bootstrapProject.root = 'changed after admission';
  bootstrapProfile.context = 'changed after admission';
  const reopened = await opening;
  assert.deepEqual(reopened.project, f.project);
  assert.equal((await reopened.settings.profile())?.revision, 1);
  assert.equal((await reopened.settings.profile())?.context, 'Authoritative context');
  const detached = reopened.project;
  detached.name = 'Caller mutation';
  assert.equal(reopened.project.name, 'Saved project name');
  assert.throws(
    () => Object.defineProperty(reopened, 'project', { value: bootstrapProject }),
    TypeError,
  );
  assert.throws(() => Object.defineProperty(reopened, 'settings', { value: {} }), TypeError);
});

test('reopening with another immutable project binding fails without replacing saved metadata', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { id: 'foreign' },
    { root: 'another-source' },
    { managed: false },
    { dataDirectory: 'another-directory' },
  ]) {
    await assert.rejects(f.open({ project: { ...f.project, ...patch } }), {
      code: 'USAGE_PROJECT_MISMATCH',
    });
  }
  const valid = await f.open({ project: { ...f.project, name: 'Bootstrap-only name' } });
  assert.deepEqual(valid.project, f.project);
  assert.equal((await valid.settings.profile())?.context, 'Authoritative context');
});

test('a profile-less authority stays unconfigured when reopened with a later bootstrap proposal', async (t) => {
  const f = await fixture(t, null);
  assert.equal(await f.authority.settings.profile(), undefined);
  await f.authority.close();
  const reopened = await f.open({ profile: profile() });
  assert.equal(await reopened.settings.profile(), undefined);
  assert.equal(await reopened.settings.verification(), undefined);
  assert.equal(await reopened.settings.researchProposal(), undefined);
  assert.equal(await reopened.settings.hasActiveRun(), false);
});

test('settings CAS, shared receipts and stale verification keep their original authoritative revisions', async (t) => {
  const f = await fixture(t);
  const second = await f.authority.settings.transaction(command('second'), (tx) =>
    tx.configure({ expectedRevision: 1, profile: profile(1, 'Second context') }),
  );
  assert.equal(second.revision, 2);
  await assert.rejects(
    f.authority.settings.transaction(command('stale'), (tx) =>
      tx.configure({ expectedRevision: 1, profile: profile(1, 'Stale') }),
    ),
    { code: 'CONFLICT' },
  );
  await f.authority.settings.transaction(command('third'), (tx) =>
    tx.configure({ expectedRevision: 2, profile: profile(2, 'Third context') }),
  );
  assert.deepEqual(await f.authority.settings.receipt(command('second')), { result: second });
  assert.deepEqual(
    await f.authority.transaction(command('second'), () => {
      throw Error('Do not reapply old configuration');
    }),
    second,
  );
  assert.equal((await f.authority.settings.profile())?.context, 'Third context');
  const oldVerification = verification(1);
  await f.authority.settings.transaction(command('verification'), (tx) =>
    tx.saveVerification(oldVerification),
  );
  assert.equal((await f.authority.settings.verification())?.profileRevision, 1);
  assert.equal((await f.authority.settings.profile())?.revision, 3);
  const events = (await f.authority.pagedEvents({ after: 0, limit: 10 })).events;
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, 'project.configured'],
      [2, 'project.configured'],
      [3, 'project.verified'],
    ],
  );
});

test('settings, entities and usage share one rollback, command receipt and event sequence', async (t) => {
  const f = await fixture(t);
  const owner = { kind: 'run' as const, runId: 'R-one' };
  const work = (tx: Parameters<Parameters<typeof f.authority.transaction>[1]>[0]) => {
    tx.entities.createGoal({
      id: 'G-one',
      projectId: 'p',
      title: 'Atomic settings',
      body: 'Synthetic goal',
      criteria: '',
      status: 'draft',
      revision: 1,
      createdAt: 'now',
    });
    tx.usage.createAccount(owner, {
      id: 'private-account',
      policy: {
        version: 1,
        maxRequests: 1,
        maxReservedOutputTokens: 10,
        maxToolCalls: 1,
        reviewReserve: { requests: 0, outputTokens: 0, toolCalls: 0 },
      },
    });
    return tx.settings.configure({ expectedRevision: 1, profile: profile(1, 'Atomic context') });
  };
  await assert.rejects(
    f.authority.transaction(command('all'), (tx) => {
      work(tx);
      throw Error('Injected rollback');
    }),
    /Injected rollback/,
  );
  assert.equal((await f.authority.settings.profile())?.revision, 1);
  assert.equal(await f.authority.entities.goal('G-one'), undefined);
  assert.equal(await f.authority.account(owner), undefined);
  assert.equal(await f.authority.settings.receipt(command('all')), undefined);
  assert.deepEqual((await f.authority.pagedEvents({ after: 0, limit: 10 })).events, []);
  await f.authority.transaction(command('all'), work);
  const events = (await f.authority.pagedEvents({ after: 0, limit: 10 })).events;
  assert.deepEqual(
    events.map((event) => [event.sequence, event.type]),
    [
      [1, 'goal.created'],
      [2, 'usage.changed'],
      [3, 'project.configured'],
    ],
  );
});

test('settings callbacks remain synchronous and retained capabilities cannot mutate a later transaction', async (t) => {
  const f = await fixture(t);
  let retained!: SettingsTransaction;
  await f.authority.settings.transaction(command('capture'), (tx) => {
    retained = tx;
    return tx.profile();
  });
  assert.throws(() => retained.profile(), { code: 'USAGE_TRANSACTION_CLOSED' });
  await assert.rejects(
    f.authority.settings.transaction(command('async'), async (tx) => {
      tx.configure({ expectedRevision: 1, profile: profile(1, 'Must roll back') });
    }),
    { code: 'ASYNC_USAGE_TRANSACTION' },
  );
  assert.equal((await f.authority.settings.profile())?.revision, 1);
  assert.equal((await f.authority.pagedEvents({ after: 0, limit: 10 })).events.length, 0);
});

test('a valid zero-revision bootstrap profile configures through the same expected-revision contract', async (t) => {
  const f = await fixture(t, profile(0));
  assert.equal((await f.authority.settings.profile())?.revision, 0);
  const configured = await f.authority.settings.transaction(command('from-zero'), (tx) =>
    tx.configure({ expectedRevision: 0, profile: profile(0, 'First saved settings') }),
  );
  assert.equal(configured.revision, 1);
  assert.equal((await f.authority.settings.profile())?.context, 'First saved settings');
});
