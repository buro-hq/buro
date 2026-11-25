import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const reporter = fileURLToPath(new URL('../../tooling/test-reporter.mjs', import.meta.url));

test('compact reporting preserves nested failures, skipped tests, diagnostics and the failing exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'buro-test-reporter-'));
  const fixture = path.join(directory, 'fixture.mjs');
  const env = { ...process.env };

  // The fixture is an independent test runner, not a worker of this test process.
  delete env.NODE_TEST_CONTEXT;

  try {
    await writeFile(fixture, `
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
describe('nested suite', () => {
  test('passing detail', () => {});
  test('skipped detail', { skip: 'skip reason sentinel' }, () => {});
  test('failing detail', context => {
    context.diagnostic('diagnostic sentinel');
    console.log('stdout sentinel');
    console.error('stderr sentinel');
    assert.equal('actual sentinel', 'expected sentinel');
  });
});
`);

    await assert.rejects(exec(process.execPath, ['--test', '--test-reporter=' + reporter, fixture], {
      env,
    }), (error) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      const output = result.stdout + result.stderr;

      assert.equal(result.code, 1);
      assert.doesNotMatch(output, /passing detail/);

      for (const text of ['failing detail', 'skipped detail', 'skip reason sentinel', 'diagnostic sentinel', 'stdout sentinel', 'stderr sentinel', 'actual sentinel', 'expected sentinel', 'fixture.mjs'])
        assert.ok(output.includes(text), 'Missing failure evidence: ' + text);

      assert.match(output, /tests 3/);
      assert.match(output, /fail 1/);
      assert.match(output, /skipped 1/);
      return true;
    });

    await writeFile(fixture, `import test from 'node:test'; test('passing detail', () => {});`);
    const result = await exec(process.execPath, ['--test', '--test-reporter=' + reporter, fixture], {
      env,
    });

    assert.doesNotMatch(result.stdout, /passing detail/);
    assert.match(result.stdout, /tests 1/);
    assert.match(result.stdout, /pass 1/);
    assert.match(result.stdout, /fail 0/);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
