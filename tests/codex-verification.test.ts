import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRuntime } from '../adapters/codex/runtime.ts';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { nativeVerificationPolicy } from '../adapters/codex/verification-policy.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { VerificationView } from '../protocol/verification.ts';

async function fixture(t: any, acknowledge: boolean | string = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-native-view-')));
  const source = path.join(root, 'writer');
  const input = path.join(root, 'frozen');
  const output = path.join(root, 'outputs');
  await Promise.all([source, input, output].map((dir) => fs.mkdir(dir)));
  const log = path.join(root, 'wire.jsonl');
  const script = path.join(root, 'fake-native.mjs');
  await fs.writeFile(
    script,
    `import fs from 'node:fs';import readline from 'node:readline';
const log=${JSON.stringify(log)};fs.appendFileSync(log,JSON.stringify({argv:process.argv.slice(2)})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})){
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{serverInfo:'fixture'}});
 else if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'review'},${acknowledge ? 'activePermissionProfile:{id:' + (typeof acknowledge === 'string' ? JSON.stringify(acknowledge) : 'm.params.permissions') + '}' : ''}}});
 else if(m.method==='turn/start'){
   const id='turn-'+m.id;send({id:m.id,result:{turn:{id}}});
   send({method:'item/completed',params:{threadId:'review',turnId:id,item:{type:'agentMessage',text:'reviewed'}}});
   send({method:'turn/completed',params:{threadId:'review',turn:{id,status:'completed'}}});
 }
}
`,
  );
  const view: VerificationView = {
    version: 1,
    id: 'verification-fixture',
    projectId: 'p',
    runId: 'R',
    sourceWorkspace: source,
    readRoot: input,
    outputRoot: output,
    base: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    outputPaths: [],
  };
  const owner = { id: 'R', workspace: source, baseCommit: view.base, verificationView: view };
  const projects = {
    get: () => ({ snapshot: () => ({ project: { root: source }, runs: [owner] }) }),
  } as unknown as ProjectRegistry;
  const executors = new EnvironmentExecutors();
  await executors.registerVerification(view, new AbortController().signal);
  const runtime = new CodexRuntime({
    id: 'native-review',
    projects,
    executors,
    executable: process.execPath,
    args: [script],
  });
  t.after(async () => {
    await runtime.dispose();
    executors.releaseVerification(view);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    view,
    owner,
    executors,
    runtime,
    log,
    read: async () =>
      (await fs.readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

test('native immutable review uses its acknowledged named profile at start, turn and submit without legacy sandbox fallback', async (t) => {
  const f = await fixture(t);
  const session = await f.runtime.start({
    projectId: 'p',
    runId: 'R',
    workspace: f.view.readRoot,
    readOnly: true,
    instructions: 'review frozen input',
  });
  await f.runtime.turn(session.threadId, 'review', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  await f.runtime.submit(session.threadId, 'another review');
  const wire = await f.read();
  const argv = wire.find((item) => item.argv).argv as string[];
  const profile = argv.find((value) => value.startsWith('permissions.buro_verification_'));
  assert.ok(profile?.includes('"/"="deny"'));
  assert.ok(profile?.includes(JSON.stringify(f.view.readRoot) + '="read"'));
  assert.ok(profile?.includes(JSON.stringify(f.view.outputRoot) + '="read"'));
  assert.ok(profile?.includes(JSON.stringify(f.view.sourceWorkspace) + '="deny"'));
  assert.ok(!profile?.includes('="write"'));
  const start = wire.find((item) => item.method === 'thread/start');
  assert.equal(start.params.permissions, 'buro_verification_verification-fixture');
  assert.deepEqual(
    argv.filter((value) => value.startsWith('default_permissions=')),
    [`default_permissions=${JSON.stringify(start.params.permissions)}`],
  );
  assert.equal(start.params.sandbox, undefined);
  const turns = wire.filter((item) => item.method === 'turn/start');
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.equal(turn.params.permissions, start.params.permissions);
    assert.equal(turn.params.sandboxPolicy, undefined);
  }
  assert.throws(() => f.runtime.get(session.threadId).sandboxPolicy(), {
    code: 'ENVIRONMENT_UNAVAILABLE',
  });
});

test('native immutable resume selects the same issued default and explicit permission profile', async (t) => {
  const f = await fixture(t);
  const session = await f.runtime.resume({
    projectId: 'p',
    runId: 'R',
    threadId: 'saved-review',
    workspace: f.view.readRoot,
    readOnly: true,
    instructions: 'resume frozen review',
  });
  await f.runtime.turn(session.threadId, 'review', {
    schema: {},
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  const wire = await f.read();
  const argv = wire.find((item) => item.argv).argv as string[];
  const resume = wire.find((item) => item.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'saved-review');
  assert.equal(resume.params.permissions, 'buro_verification_verification-fixture');
  assert.equal(resume.params.sandbox, undefined);
  assert.deepEqual(
    argv.filter((value) => value.startsWith('default_permissions=')),
    [`default_permissions=${JSON.stringify(resume.params.permissions)}`],
  );
  const turn = wire.find((item) => item.method === 'turn/start');
  assert.equal(turn.params.permissions, resume.params.permissions);
  assert.equal(turn.params.sandboxPolicy, undefined);
});

test('ordinary native writer does not receive an immutable review default permission override', async (t) => {
  const f = await fixture(t);
  await f.runtime.start({
    projectId: 'p',
    runId: 'R',
    workspace: f.source,
    readOnly: false,
    instructions: 'write in the isolated workspace',
  });
  const wire = await f.read();
  const argv = wire.find((item) => item.argv).argv as string[];
  assert.equal(
    argv.some((value) => value.startsWith('default_permissions=')),
    false,
  );
  assert.equal(
    argv.some((value) => value.startsWith('permissions.buro_verification_')),
    false,
  );
  const start = wire.find((item) => item.method === 'thread/start');
  assert.equal(start.params.permissions, undefined);
  assert.equal(start.params.sandbox, 'workspace-write');
});

test('an ignored permission profile is rejected before any native model turn', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    f.runtime.start({
      projectId: 'p',
      runId: 'R',
      workspace: f.view.readRoot,
      readOnly: true,
      instructions: 'review',
    }),
    { code: 'ENVIRONMENT_UNAVAILABLE' },
  );
  assert.equal((await f.read()).filter((item) => item.method === 'turn/start').length, 0);
});

test('a different acknowledged profile cannot substitute for the issued native review default', async (t) => {
  const f = await fixture(t, 'another-profile');
  await assert.rejects(
    f.runtime.start({
      projectId: 'p',
      runId: 'R',
      workspace: f.view.readRoot,
      readOnly: true,
      instructions: 'review',
    }),
    { code: 'ENVIRONMENT_UNAVAILABLE' },
  );
  const wire = await f.read();
  const argv = wire.find((item) => item.argv).argv as string[];
  const start = wire.find((item) => item.method === 'thread/start');
  assert.ok(argv.includes(`default_permissions=${JSON.stringify(start.params.permissions)}`));
  assert.notEqual(start.params.permissions, 'another-profile');
  assert.equal(wire.filter((item) => item.method === 'turn/start').length, 0);
});

test('revoked or rebound verification ownership dispatches no native turn', async (t) => {
  const f = await fixture(t);
  const session = await f.runtime.start({
    projectId: 'p',
    runId: 'R',
    workspace: f.view.readRoot,
    readOnly: true,
    instructions: 'review',
  });
  f.owner.baseCommit = 'c'.repeat(40);
  await assert.rejects(
    f.runtime.turn(session.threadId, 'review', {
      schema: {},
      signal: new AbortController().signal,
      timeoutMs: 1000,
    }),
    { code: 'VERIFICATION_VIEW_CHANGED' },
  );
  f.owner.baseCommit = f.view.base;
  f.executors.releaseVerification(f.view);
  await assert.rejects(f.runtime.submit(session.threadId, 'review'), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
  assert.equal((await f.read()).filter((item) => item.method === 'turn/start').length, 0);
});

test('native view requires read-only ownership and rejects a grant for the original source root', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.runtime.start({
      projectId: 'p',
      runId: 'R',
      workspace: f.view.readRoot,
      readOnly: false,
      instructions: 'write',
    }),
    { code: 'VERIFICATION_VIEW_CHANGED' },
  );
  assert.throws(
    () => nativeVerificationPolicy(f.view, { readRoots: [f.source], deniedRoots: [] }, f.source),
    { code: 'ENVIRONMENT_UNAVAILABLE' },
  );
  delete (f.owner as { verificationView?: VerificationView }).verificationView;
  await assert.rejects(
    f.runtime.start({
      projectId: 'p',
      runId: 'R',
      workspace: f.view.readRoot,
      readOnly: true,
      instructions: 'review',
    }),
    { code: 'VERIFICATION_VIEW_CHANGED' },
  );
});
