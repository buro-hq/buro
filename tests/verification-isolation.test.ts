import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentExecutors } from '../adapters/environments/executors.ts';
import { ProjectChecks } from '../adapters/checks/project-commands.ts';
import { NodeChecks } from '../adapters/checks/node-checks.ts';
import type { ProjectRegistry } from '../core/ports.ts';
import type { ProjectProfile } from '../protocol/domain.ts';
import type { VerificationView } from '../protocol/verification.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function writable(directory: string) {
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await writable(path.join(directory, entry.name));
}

async function fixture(t: any) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'verification-isolation-')),
  );
  const sourceWorkspace = path.join(root, 'workspace');
  const projectRoot = path.join(root, 'project');
  const readRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  await Promise.all([sourceWorkspace, projectRoot, readRoot, outputRoot].map((p) => fs.mkdir(p)));
  await fs.mkdir(path.join(readRoot, 'src'));
  await fs.mkdir(path.join(sourceWorkspace, 'src'));
  await fs.writeFile(path.join(readRoot, 'src/value.txt'), 'frozen');
  await fs.writeFile(path.join(sourceWorkspace, 'src/value.txt'), 'live');
  await fs.mkdir(path.join(outputRoot, 'dist'));
  await fs.symlink(path.join(outputRoot, 'dist'), path.join(readRoot, 'dist'), 'dir');
  const view: VerificationView = {
    version: 1,
    id: 'view',
    projectId: 'p',
    runId: 'r',
    sourceWorkspace,
    readRoot,
    outputRoot,
    base: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    outputPaths: ['dist'],
  };
  const owner = {
    id: 'r',
    workspace: sourceWorkspace,
    baseCommit: view.base,
    verificationView: view,
  };
  const projects = {
    get: () => ({ snapshot: () => ({ project: { id: 'p', root: projectRoot }, runs: [owner] }) }),
  } as unknown as ProjectRegistry;
  const executors = new EnvironmentExecutors();
  const world = await executors.register(
    sourceWorkspace,
    projectRoot,
    { provider: 'native' },
    new AbortController().signal,
  );
  const binaryDirectory = path.join(world.variables.HOME, 'fixture-bin');
  await fs.mkdir(binaryDirectory);
  await fs.writeFile(
    path.join(binaryDirectory, 'prepared-tool'),
    '#!/bin/sh\necho prepared-toolchain\n',
    { mode: 0o755 },
  );
  world.variables.PATH = binaryDirectory + path.delimiter + world.variables.PATH;
  let fallbackCalls = 0;
  const checks = new ProjectChecks(
    projects,
    {
      async run() {
        fallbackCalls++;
        throw Error('Unexpected host fallback');
      },
    },
    executors,
  );
  const profile = {
    version: 1,
    revision: 1,
    checks: [],
    environment: { provider: 'native' },
  } as unknown as ProjectProfile;
  t.after(async () => {
    await writable(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    projects,
    checks,
    executors,
    sourceWorkspace,
    projectRoot,
    readRoot,
    outputRoot,
    view,
    owner,
    world,
    profile,
    fallbackCalls: () => fallbackCalls,
  };
}

test(
  'verification inputs resist writes, ABA, rename, hardlinks and chmod while declared outputs remain writable',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const script = `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const input = path.join(process.cwd(),'src/value.txt');
const blocked = {};
for (const [name, operation] of Object.entries({
  write: () => fs.writeFileSync(input,'changed'),
  aba: () => {fs.writeFileSync(input,'temporary');fs.writeFileSync(input,'frozen');},
  rename: () => fs.renameSync(input,path.join(process.env.TMPDIR,'renamed')),
  hardlink: () => {const p=path.join(process.env.TMPDIR,'hardlink');fs.linkSync(input,p);fs.writeFileSync(p,'changed');},
  chmod: () => fs.chmodSync(input,0o666),
  symlink: () => {const p=path.join(process.env.TMPDIR,'alias');fs.symlinkSync(input,p);fs.writeFileSync(p,'changed');},
  liveRead: () => fs.readFileSync(${JSON.stringify(path.join(f.sourceWorkspace, 'src/value.txt'))}),
})) {try {operation();blocked[name]=false;}catch {blocked[name]=true;}}
assert.ok(Object.values(blocked).every(Boolean),JSON.stringify(blocked));
assert.equal(fs.readFileSync(input,'utf8'),'frozen');
assert.equal(process.env.PROJECT_ROOT,process.cwd());
assert.equal(process.env.GOAL_WORKSPACE,process.cwd());
fs.writeFileSync(path.join(process.cwd(),'dist/generated.txt'),'output');
fs.writeFileSync(path.join(process.env.HOME,'state'),'home');
fs.writeFileSync(path.join(process.env.TMPDIR,'temporary'),'temp');
console.log(JSON.stringify(blocked));
`;
    await fs.writeFile(path.join(f.readRoot, 'check.mjs'), script);
    await fs.chmod(path.join(f.readRoot, 'src/value.txt'), 0o444);
    await fs.chmod(path.join(f.readRoot, 'src'), 0o555);
    await fs.chmod(path.join(f.readRoot, 'check.mjs'), 0o444);
    await fs.chmod(f.readRoot, 0o555);
    f.profile.checks = [
      {
        id: 'check',
        title: 'Immutable inputs',
        command: quote(process.execPath) + ' check.mjs && prepared-tool',
        timeoutMs: 5000,
        outputPaths: ['dist'],
      },
    ];
    const result = await f.checks.run(
      'p',
      f.sourceWorkspace,
      ['check'],
      new AbortController().signal,
      f.profile,
      { verificationView: f.view },
    );
    assert.equal(result.passed, 1, result.results[0].output);
    assert.match(result.results[0].output || '', /prepared-toolchain/);
    assert.equal(await fs.readFile(path.join(f.readRoot, 'src/value.txt'), 'utf8'), 'frozen');
    assert.equal(await fs.readFile(path.join(f.sourceWorkspace, 'src/value.txt'), 'utf8'), 'live');
    assert.equal(
      await fs.readFile(path.join(f.outputRoot, 'dist/generated.txt'), 'utf8'),
      'output',
    );
    assert.equal(f.fallbackCalls(), 0);
  },
);

test('verification grants reject forged owners, changed outputs, released handles and Docker without host fallback', async (t) => {
  const f = await fixture(t);
  f.profile.checks = [
    {
      id: 'check',
      title: 'No dispatch',
      command: 'exit 0',
      timeoutMs: 1000,
      outputPaths: ['dist'],
    },
  ];
  const run = (view: VerificationView) =>
    f.checks.run('p', f.sourceWorkspace, ['check'], new AbortController().signal, f.profile, {
      verificationView: view,
    });
  await assert.rejects(run({ ...f.view, tree: 'c'.repeat(40) }), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
  f.profile.checks[0].outputPaths = [];
  await assert.rejects(run(f.view), { code: 'VERIFICATION_VIEW_CHANGED' });
  f.profile.checks[0].outputPaths = ['dist'];
  await f.executors.registerVerification(f.view, new AbortController().signal);
  await f.checks.releaseVerificationView(f.view);
  assert.throws(() => f.executors.launchVerification(f.view, ['true']), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
  f.world.config = { provider: 'docker', image: 'unavailable-fixture' };
  await assert.rejects(f.executors.registerVerification(f.view, new AbortController().signal), {
    code: 'ENVIRONMENT_UNAVAILABLE',
  });
  assert.equal(f.fallbackCalls(), 0);
});

test('legacy trusted Node checks read the issued input view with no file-write permission', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.root, 'trusted.mjs');
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
import path from 'node:path';
let denied=false;try {fs.writeFileSync(path.join(process.env.GOAL_WORKSPACE,'src/value.txt'),'changed');}catch {denied=true;}
console.log(JSON.stringify({results:[{name:'immutable',passed:denied&&fs.readFileSync(path.join(process.env.GOAL_WORKSPACE,'src/value.txt'),'utf8')==='frozen'}]}));
`,
  );
  const checks = new ProjectChecks(
    f.projects,
    new NodeChecks({ p: [{ id: 'legacy', title: 'Trusted', script }] }),
  );
  const result = await checks.run(
    'p',
    f.sourceWorkspace,
    ['legacy'],
    new AbortController().signal,
    undefined,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 1, JSON.stringify(result.results));
  assert.equal(await fs.readFile(path.join(f.readRoot, 'src/value.txt'), 'utf8'), 'frozen');
});

test('prepared dependencies support actual Node package resolution inside immutable verification', async (t) => {
  const f = await fixture(t);
  const dependency = path.join(f.sourceWorkspace, 'node_modules');
  await fs.mkdir(path.join(dependency, 'fixture-dependency'), { recursive: true });
  await fs.writeFile(
    path.join(dependency, 'fixture-dependency/package.json'),
    JSON.stringify({ name: 'fixture-dependency', main: 'index.cjs' }),
  );
  await fs.writeFile(path.join(dependency, 'fixture-dependency/index.cjs'), 'module.exports = 42;');
  await fs.symlink(dependency, path.join(f.readRoot, 'node_modules'), 'dir');
  f.view.readonlyDependencies = [
    { path: path.join(f.readRoot, 'node_modules'), target: dependency },
  ];
  f.profile.checks = [
    {
      id: 'check',
      title: 'ESM package resolution',
      command:
        quote(process.execPath) +
        ' --input-type=module -e ' +
        quote("import value from 'fixture-dependency'; if (value !== 42) process.exit(2);"),
      timeoutMs: 5000,
      outputPaths: ['dist'],
    },
  ];
  const result = await f.checks.run(
    'p',
    f.sourceWorkspace,
    ['check'],
    new AbortController().signal,
    f.profile,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 1, result.results[0].output);
});

test('only the prepared dependency target is readable and its contents remain read-only', async (t) => {
  const f = await fixture(t);
  const dependency = path.join(f.sourceWorkspace, 'node_modules');
  await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, 'fixture.txt'), 'prepared');
  await fs.symlink(dependency, path.join(f.readRoot, 'node_modules'), 'dir');
  f.view.readonlyDependencies = [
    { path: path.join(f.readRoot, 'node_modules'), target: dependency },
  ];
  const code = `const fs=require('node:fs');const p='node_modules/fixture.txt';if(fs.readFileSync(p,'utf8')!=='prepared')process.exit(2);let denied=false;try{fs.writeFileSync(p,'bad')}catch{denied=true}if(!denied)process.exit(3)`;
  f.profile.checks = [
    {
      id: 'check',
      title: 'Dependency isolation',
      command: quote(process.execPath) + ' -e ' + quote(code),
      timeoutMs: 5000,
      outputPaths: ['dist'],
    },
  ];
  const result = await f.checks.run(
    'p',
    f.sourceWorkspace,
    ['check'],
    new AbortController().signal,
    f.profile,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 1, result.results[0].output);
  assert.equal(await fs.readFile(path.join(dependency, 'fixture.txt'), 'utf8'), 'prepared');
  await f.checks.releaseVerificationView(f.view);
  const unrelated = path.join(f.root, 'unrelated');
  await fs.mkdir(unrelated);
  await fs.unlink(path.join(f.readRoot, 'node_modules'));
  await fs.symlink(unrelated, path.join(f.readRoot, 'node_modules'), 'dir');
  const forged = {
    ...f.view,
    readonlyDependencies: [{ path: path.join(f.readRoot, 'node_modules'), target: unrelated }],
  };
  await assert.rejects(f.executors.registerVerification(forged, new AbortController().signal), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
});

test('a dependency alias cannot grant access to protected service credentials', async (t) => {
  const f = await fixture(t);
  const credentials = path.join(f.root, 'private-credentials');
  await fs.mkdir(credentials);
  f.executors.protectPrivatePaths([credentials]);
  await fs.symlink(credentials, path.join(f.sourceWorkspace, 'node_modules'), 'dir');
  await fs.symlink(credentials, path.join(f.readRoot, 'node_modules'), 'dir');
  const forged = {
    ...f.view,
    readonlyDependencies: [{ path: path.join(f.readRoot, 'node_modules'), target: credentials }],
  };
  await assert.rejects(f.executors.registerVerification(forged, new AbortController().signal), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
});

test('checks sharing nested output directories use the same issued root grant', async (t) => {
  const f = await fixture(t);
  // Canonical grant ordering is length-first, independent of the input order.
  f.view.outputPaths = ['z', 'dist'];
  await fs.mkdir(path.join(f.outputRoot, 'z'));
  await fs.symlink(path.join(f.outputRoot, 'z'), path.join(f.readRoot, 'z'), 'dir');
  f.profile.checks = [
    {
      id: 'build',
      title: 'Build',
      outputPaths: ['dist/', 'z'],
      timeoutMs: 5000,
      command:
        quote(process.execPath) +
        ' -e ' +
        quote("require('node:fs').writeFileSync('dist/build.txt','built')"),
    },
    {
      id: 'report',
      title: 'Report',
      outputPaths: ['dist/reports'],
      timeoutMs: 5000,
      command:
        quote(process.execPath) +
        ' -e ' +
        quote(
          "const fs=require('node:fs');fs.mkdirSync('dist/reports',{recursive:true});fs.writeFileSync('dist/reports/check.txt',fs.readFileSync('dist/build.txt'))",
        ),
    },
  ];
  const result = await f.checks.run(
    'p',
    f.sourceWorkspace,
    ['build', 'report'],
    new AbortController().signal,
    f.profile,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 2, JSON.stringify(result.results));
  assert.equal(
    await fs.readFile(path.join(f.outputRoot, 'dist/reports/check.txt'), 'utf8'),
    'built',
  );
  assert.equal(await fs.readFile(path.join(f.readRoot, 'src/value.txt'), 'utf8'), 'frozen');
  await f.checks.releaseVerificationView(f.view);
});
