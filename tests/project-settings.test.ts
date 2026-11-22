import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectProfile, ProjectVerification } from '../protocol/domain.ts';
import {
  createSettingsTransaction,
  projectResearchProposal,
  policyView,
  validateProjectSettingsChange,
  type ResearchProposal,
  type ResearchAcknowledgement,
  type SettingsTransactionStorage,
  type ProjectSettingsChange,
} from '../core/project-settings.ts';

const initial: ProjectProfile = {
  version: 1,
  revision: 1,
  context: '',
  scope: { mode: 'advisory', plannedPaths: [], protectedPaths: ['AGENTS.md'] },
  checks: [{ id: 'test', title: 'Tests', command: 'synthetic test', timeoutMs: 1000 }],
  defaultCheckIds: ['test'],
  setup: [],
  dependencies: 'none',
  maxWorkers: 2,
  turnTimeoutMs: 10000,
  baseBranch: 'main',
};

test('project configuration accepts a chosen team allowance and rejects invalid counts', () => {
  const f = fixture();
  const saved = f.tx.configure({ expectedRevision: 1, profile: { ...initial, maxWorkers: 5 } });
  assert.equal(saved.maxWorkers, 5);
  assert.equal(f.tx.profile()?.maxWorkers, 5);
  for (const maxWorkers of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.tx.configure({ expectedRevision: 2, profile: { ...saved, maxWorkers } }));
    assert.equal(f.tx.profile()?.maxWorkers, 5);
  }
});
const proposal: ResearchProposal = {
  id: 'research',
  status: 'ready',
  analysis: { id: 'project-setup', revision: 'v1' },
  sourceHead: 'a'.repeat(40),
  profileRevision: 1,
  context: 'Suggestion',
};
function fixture(start: ProjectProfile = initial) {
  let profile = structuredClone(start),
    research: ResearchProposal | undefined = structuredClone(proposal),
    verification: ProjectVerification | undefined;
  let busy = false,
    active = true,
    writes = 0;
  const events: ProjectSettingsChange[] = [];
  const storage: SettingsTransactionStorage = {
    profile: () => profile,
    researchProposal: () => research,
    verification: () => verification,
    hasActiveRun: () => busy,
    replaceProfile(previous, next) {
      assert.deepEqual(profile, previous);
      profile = next;
      writes++;
    },
    acknowledgeResearch(expected, acknowledgement) {
      assert.deepEqual(research, expected);
      research = { ...research!, ...acknowledgement };
      writes++;
    },
    saveVerification(value) {
      verification = value;
      writes++;
    },
    appendChange: (change) => {
      events.push(change);
    },
  };
  const tx = createSettingsTransaction({
    projectId: 'project',
    storage,
    assertActive() {
      if (!active) throw Error('closed');
    },
  });
  return {
    tx,
    events,
    writes: () => writes,
    busy: (value: boolean) => {
      busy = value;
    },
    proposal: (value: ResearchProposal | undefined) => {
      research = value;
    },
    close: () => {
      active = false;
    },
  };
}

test('research projection reads only explicitly selected bounded proposal fields', () => {
  const complete = { ...proposal };
  for (const key of ['events', 'resources', 'roleSnapshot', 'roleResource', 'contextMaterials'])
    Object.defineProperty(complete, key, {
      get() {
        throw Error('Private or historical research must never be read.');
      },
    });
  const result = projectResearchProposal(complete)!;
  assert.deepEqual(result, proposal);
  result.analysis.revision = 'changed copy';
  assert.equal(complete.analysis.revision, 'v1');
  assert.equal(projectResearchProposal(undefined), undefined);
});

test('profile CAS and bounded proposal checks happen before any writes, while manual acknowledgement uses current form revision', () => {
  const f = fixture();
  f.busy(true);
  assert.throws(() => f.tx.configure({ expectedRevision: 0, profile: initial }), {
    code: 'PROJECT_BUSY',
  });
  f.busy(false);
  assert.throws(() => f.tx.configure({ expectedRevision: 0, profile: initial }), {
    code: 'CONFLICT',
  });
  assert.throws(
    () =>
      f.tx.configure({
        expectedRevision: 1,
        profile: initial,
        expectedResearch: { ...proposal, context: 'Other result' },
      }),
    { code: 'RESEARCH_STALE' },
  );
  assert.equal(f.writes(), 0);
  const manual = f.tx.configure({
    expectedRevision: 1,
    profile: { ...initial, context: 'User edits' },
  });
  assert.equal(manual.revision, 2);
  assert.deepEqual(f.tx.researchProposal(), { ...proposal, reviewedProfileRevision: 2 });
  const applied = f.tx.configure({
    expectedRevision: 2,
    profile: manual,
    expectedResearch: proposal,
  });
  assert.equal(applied.revision, 3);
  assert.equal(applied.context, 'User edits');
  assert.equal(f.tx.researchProposal()?.profileRevision, 1);
  const ack: ResearchAcknowledgement = {
    id: proposal.id,
    reviewedProfileRevision: 3,
    appliedProfileRevision: 3,
  };
  assert.deepEqual(f.events[1], {
    type: 'project.configured',
    profile: applied,
    executionPolicy: policyView(applied),
    researchAcknowledgement: ack,
  });
  assert.equal('research' in f.events[1], false);
});

test('a saved verification retains its captured profile revision and detached result despite newer settings', () => {
  const f = fixture();
  f.tx.configure({ expectedRevision: 1, profile: initial });
  const result: ProjectVerification = {
    id: 'verify',
    createdAt: 'now',
    profileRevision: 1,
    workspace: 'workspace',
    base: 'base',
    passed: 1,
    total: 1,
    results: [{ name: 'Tests', passed: true }],
  };
  const saved = f.tx.saveVerification(result);
  saved.results[0].passed = false;
  assert.equal(f.tx.verification()?.results[0].passed, true);
  assert.equal(f.tx.verification()?.profileRevision, 1);
  assert.equal(f.tx.profile()?.revision, 2);
  assert.deepEqual(validateProjectSettingsChange(f.events[1]), f.events[1]);
});

test('public settings projections reject mismatched policy/private payload and expired capabilities stop reads and writes', () => {
  const f = fixture();
  const configured = f.tx.configure({ expectedRevision: 1, profile: initial });
  for (const event of [
    { type: 'project.configured', profile: configured, executionPolicy: undefined },
    {
      type: 'project.configured',
      profile: configured,
      executionPolicy: { ...policyView(configured), maxWorkers: 99 },
    },
    {
      type: 'project.configured',
      profile: configured,
      executionPolicy: policyView(configured),
      research: { events: ['private'] },
    },
  ])
    assert.throws(() => validateProjectSettingsChange(event), { code: 'INVALID_PROJECT_SETTINGS' });
  configured.scope.protectedPaths.push('caller-mutation');
  assert.deepEqual(f.tx.profile()?.scope.protectedPaths, ['AGENTS.md']);
  f.close();
  for (const call of [
    () => f.tx.profile(),
    () => f.tx.researchProposal(),
    () => f.tx.verification(),
    () => f.tx.hasActiveRun(),
    () => f.tx.configure({ expectedRevision: 2, profile: initial }),
  ])
    assert.throws(call, /closed/);
});

test('internal base-branch initialization does not acknowledge research or depend on active work', () => {
  const { baseBranch: _baseBranch, ...missingBranch } = initial;
  const f = fixture(missingBranch);
  f.busy(true);
  const initialized = f.tx.initializeBaseBranch({ expectedRevision: 1, baseBranch: 'develop' });
  assert.equal(initialized.baseBranch, 'develop');
  assert.equal(initialized.revision, 2);
  assert.deepEqual(f.tx.researchProposal(), proposal);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.events, [
    { type: 'project.configured', profile: initialized, executionPolicy: policyView(initialized) },
  ]);
  assert.deepEqual(
    f.tx.initializeBaseBranch({ expectedRevision: 2, baseBranch: 'other' }),
    initialized,
  );
  assert.equal(f.writes(), 1);
  assert.equal(f.events.length, 1);
  assert.throws(() => f.tx.initializeBaseBranch({ expectedRevision: 1, baseBranch: 'other' }), {
    code: 'CONFLICT',
  });
  const overflow = fixture({ ...missingBranch, revision: Number.MAX_SAFE_INTEGER });
  assert.throws(
    () =>
      overflow.tx.initializeBaseBranch({
        expectedRevision: Number.MAX_SAFE_INTEGER,
        baseBranch: 'main',
      }),
    { code: 'CONFLICT' },
  );
  assert.equal(overflow.writes(), 0);
});
