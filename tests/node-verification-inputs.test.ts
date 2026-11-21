import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeChecks, type TrustedCheck } from '../adapters/checks/node-checks.ts';
import type { VerificationView } from '../protocol/verification.ts';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'node-frozen-check-')));
  const sourceRoot = path.join(root, 'source');
  const sourceWorkspace = path.join(root, 'run');
  const readRoot = path.join(root, 'input');
  const outputRoot = path.join(root, 'output');
  const standalone = path.join(root, 'trusted');
  for (const directory of [sourceRoot, sourceWorkspace, readRoot, outputRoot, standalone])
    await fs.mkdir(directory);
  for (const directory of [sourceRoot, sourceWorkspace, readRoot, standalone]) {
    await fs.mkdir(path.join(directory, 'src'));
    await fs.writeFile(
      path.join(directory, 'src/value.txt'),
      directory === readRoot ? 'frozen' : 'live',
    );
  }
  const view: VerificationView = {
    version: 1,
    id: 'node-view',
    projectId: 'p',
    runId: 'r',
    sourceWorkspace,
    readRoot,
    outputRoot,
    base: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    outputPaths: [],
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    sourceRoot,
    sourceWorkspace,
    readRoot,
    standalone,
    view,
    run(check: Omit<TrustedCheck, 'id' | 'title'>, workspace = readRoot) {
      return new NodeChecks({ p: [{ id: 'check', title: 'Trusted check', ...check }] }).run(
        'p',
        workspace,
        ['check'],
        new AbortController().signal,
        undefined,
        { verificationView: view },
      );
    },
  };
}

const relativeInputScript = `
import fs from 'node:fs';
import path from 'node:path';
const actual = fs.readFileSync(path.join(import.meta.dirname, 'src/value.txt'), 'utf8');
console.log(JSON.stringify({results:[{name:'frozen relative input',passed:actual==='frozen',error:actual}]}));
`;

test('a registered repository check executes its frozen script and import.meta.dirname reads frozen src', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceRoot, 'check.mjs');
  await fs.writeFile(script, relativeInputScript);
  await fs.writeFile(path.join(f.readRoot, 'check.mjs'), relativeInputScript);
  const result = await f.run({ script, sourceRoot: f.sourceRoot });
  assert.equal(result.passed, 1, JSON.stringify(result));
  assert.equal(result.total, 1);
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'src/value.txt'), 'utf8'), 'live');
});

test('a script registered directly under the run workspace also resolves only from the frozen view', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceWorkspace, 'check.mjs');
  await fs.writeFile(script, relativeInputScript);
  await fs.writeFile(path.join(f.readRoot, 'check.mjs'), relativeInputScript);
  assert.equal((await f.run({ script })).passed, 1);
});

test('the canonical CheckPort source workspace argument still executes only the issued frozen input', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceRoot, 'check.mjs');
  await fs.writeFile(script, relativeInputScript);
  await fs.writeFile(path.join(f.readRoot, 'check.mjs'), relativeInputScript);
  const result = await f.run({ script, sourceRoot: f.sourceRoot }, f.sourceWorkspace);
  assert.equal(result.passed, 1, JSON.stringify(result));
});

test('a standalone trusted builtin-only check reads frozen GOAL_WORKSPACE without directory grants', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.mjs');
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
import path from 'node:path';
const value = fs.readFileSync(path.join(process.env.GOAL_WORKSPACE, 'src/value.txt'), 'utf8');
console.log(JSON.stringify({results:[{name:'trusted standalone',passed:value==='frozen'}]}));
`,
  );
  assert.equal((await f.run({ script })).passed, 1);
});

test('a standalone trusted script cannot read adjacent live src through import.meta.dirname', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.mjs');
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
import path from 'node:path';
let blocked = false;
try { fs.readFileSync(path.join(import.meta.dirname, 'src/value.txt'), 'utf8'); }
catch (error) { blocked = error.code === 'ERR_ACCESS_DENIED'; }
console.log(JSON.stringify({results:[{name:'live source denied',passed:blocked}]}));
`,
  );
  const result = await f.run({ script });
  assert.equal(result.passed, 1, JSON.stringify(result));
});

test('missing or escaping frozen script is rejected instead of falling back to a live registered file', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceRoot, 'check.mjs');
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"live fallback",passed:true}]}));',
  );
  await assert.rejects(f.run({ script, sourceRoot: f.sourceRoot }), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
  await fs.symlink(script, path.join(f.readRoot, 'check.mjs'));
  await assert.rejects(f.run({ script, sourceRoot: f.sourceRoot }), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
});

test('an explicit source registration cannot silently authorize an unrelated live script', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.mjs');
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"unrelated",passed:true}]}));',
  );
  await assert.rejects(f.run({ script, sourceRoot: f.sourceRoot }), {
    code: 'VERIFICATION_VIEW_CHANGED',
  });
});

test('a standalone registration cannot alias a live run script through a symlink', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.sourceWorkspace, 'check.mjs');
  const script = path.join(f.standalone, 'alias.mjs');
  await fs.writeFile(
    target,
    'console.log(JSON.stringify({results:[{name:"live alias",passed:true}]}));',
  );
  await fs.symlink(target, script);
  await assert.rejects(f.run({ script }), { code: 'VERIFICATION_VIEW_CHANGED' });
});

test('a candidate cannot replace the registered checker with an always-pass entrypoint', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceRoot, 'check.mjs');
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"trusted failure",passed:false}]}));',
  );
  await fs.writeFile(
    path.join(f.readRoot, 'check.mjs'),
    'console.log(JSON.stringify({results:[{name:"candidate always pass",passed:true}]}));',
  );
  await assert.rejects(f.run({ script, sourceRoot: f.sourceRoot }), {
    code: 'CHECK_DEFINITION_CHANGED',
  });
});

test('registration pins protect standalone and non-view checks from later entrypoint edits', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.mjs');
  for (const immutable of [false, true]) {
    await fs.writeFile(
      script,
      'console.log(JSON.stringify({results:[{name:"trusted",passed:false}]}));',
    );
    const checks = new NodeChecks({ p: [{ id: 'check', title: 'Trusted', script }] });
    await fs.writeFile(
      script,
      'console.log(JSON.stringify({results:[{name:"changed",passed:true}]}));',
    );
    await assert.rejects(
      checks.run(
        'p',
        immutable ? f.readRoot : f.sourceWorkspace,
        ['check'],
        new AbortController().signal,
        undefined,
        immutable ? { verificationView: f.view } : {},
      ),
      { code: 'CHECK_DEFINITION_CHANGED' },
    );
  }
  assert.equal(
    (await f.run({ script })).passed,
    1,
    'A deliberate new registration may select the intended next version',
  );
});

test('a frozen checker matching its registration remains authoritative after the original host file changes', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.sourceRoot, 'check.mjs');
  await fs.writeFile(script, relativeInputScript);
  await fs.writeFile(path.join(f.readRoot, 'check.mjs'), relativeInputScript);
  const checks = new NodeChecks({
    p: [{ id: 'check', title: 'Trusted', script, sourceRoot: f.sourceRoot }],
  });
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"future host version",passed:false}]}));',
  );
  const result = await checks.run(
    'p',
    f.sourceWorkspace,
    ['check'],
    new AbortController().signal,
    undefined,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 1);
  assert.equal(result.results[0].name, 'check: frozen relative input');
});

test('mutating the caller registration object cannot replace a pinned trusted definition', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.mjs');
  const replacement = path.join(f.standalone, 'replacement.mjs');
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"registered",passed:false}]}));',
  );
  await fs.writeFile(
    replacement,
    'console.log(JSON.stringify({results:[{name:"replacement",passed:true}]}));',
  );
  const definitions = { p: [{ id: 'check', title: 'Trusted', script }] };
  const checks = new NodeChecks(definitions);
  definitions.p[0].script = replacement;
  const result = await checks.run(
    'p',
    f.readRoot,
    ['check'],
    new AbortController().signal,
    undefined,
    { verificationView: f.view },
  );
  assert.equal(result.passed, 0);
  assert.equal(result.results[0].name, 'check: registered');
});

test('a missing registration cannot silently trust a later appearing entrypoint', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'later.mjs');
  const checks = new NodeChecks({ p: [{ id: 'check', title: 'Trusted', script }] });
  await fs.writeFile(
    script,
    'console.log(JSON.stringify({results:[{name:"later",passed:true}]}));',
  );
  await assert.rejects(
    checks.run('p', f.readRoot, ['check'], new AbortController().signal, undefined, {
      verificationView: f.view,
    }),
    { code: 'CHECK_DEFINITION_CHANGED' },
  );
});

test('a post-validation live-file replacement cannot replace the pinned standalone or baseline program', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'race.mjs');
  const trusted = 'console.log(JSON.stringify({results:[{name:"pinned checker",passed:false}]}));';
  const replacement =
    'console.log(JSON.stringify({results:[{name:"late always pass",passed:true}]}));';
  for (const immutable of [false, true]) {
    await fs.writeFile(script, trusted);
    const checks = new NodeChecks({ p: [{ id: 'check', title: 'Trusted', script }] });
    const readFile = fs.readFile;
    let replaced = false;
    fs.readFile = (async (...args: any[]) => {
      const content = await (readFile as any)(...args);
      if (args[0] === script && !replaced) {
        replaced = true;
        await fs.writeFile(script, replacement);
      }
      return content;
    }) as typeof fs.readFile;
    try {
      const result = await checks.run(
        'p',
        immutable ? f.readRoot : f.sourceWorkspace,
        ['check'],
        new AbortController().signal,
        undefined,
        immutable ? { verificationView: f.view } : {},
      );
      assert.equal(
        replaced,
        true,
        'The live path must change after validation read and before spawn',
      );
      assert.equal(result.passed, 0);
      assert.equal(result.results[0].name, 'check: pinned checker');
    } finally {
      fs.readFile = readFile;
    }
  }
});

test('standalone execution uses a readonly owned copy and removes it after a reported failure', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'self.mjs');
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
const readonly = (fs.statSync(import.meta.filename).mode & 0o222) === 0;
console.log(JSON.stringify({results:[{name:import.meta.filename,passed:false,error:String(readonly)}]}));
process.exitCode = 1;
`,
  );
  const result = await f.run({ script });
  assert.equal(result.passed, 0);
  const executed = result.results[0].name.slice('check: '.length);
  assert.notEqual(executed, script);
  assert.equal(path.basename(executed), 'entrypoint.mjs');
  assert.equal(result.results[0].error, 'true');
  await assert.rejects(fs.stat(executed), { code: 'ENOENT' });
});

test('a standalone CommonJS entrypoint preserves its suffix and reads the issued input', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'check.cjs');
  await fs.writeFile(
    script,
    `
const fs = require('node:fs');
const path = require('node:path');
const value = fs.readFileSync(path.join(process.env.GOAL_WORKSPACE,'src/value.txt'),'utf8');
console.log(JSON.stringify({results:[{name:'CommonJS pinned input',passed:value==='frozen'&&__filename.endsWith('.cjs')}]}));
`,
  );
  assert.equal((await f.run({ script })).passed, 1);
});

test('cancellation removes the per-invocation pinned copy', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.standalone, 'waiting.mjs');
  await fs.writeFile(script, 'setInterval(() => {}, 1000);');
  const checks = new NodeChecks({ p: [{ id: 'check', title: 'Trusted', script }] });
  const controller = new AbortController();
  const writeFile = fs.writeFile;
  let copied!: (filename: string) => void;
  const copy = new Promise<string>((resolve) => {
    copied = resolve;
  });
  fs.writeFile = (async (...args: any[]) => {
    const result = await (writeFile as any)(...args);
    if (typeof args[0] === 'string' && args[0].includes('buro-trusted-entrypoint-'))
      copied(args[0]);
    return result;
  }) as typeof fs.writeFile;
  try {
    const pending = assert.rejects(
      checks.run('p', f.readRoot, ['check'], controller.signal, undefined, {
        verificationView: f.view,
      }),
      { name: 'AbortError' },
    );
    const filename = await copy;
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await pending;
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  } finally {
    fs.writeFile = writeFile;
    controller.abort();
  }
});
