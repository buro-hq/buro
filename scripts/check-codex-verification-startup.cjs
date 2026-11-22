// Offline installed-client check: generated inputs, private empty config, denied network, no turns.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const exec = promisify(execFile);

async function probe(executable, directory, view, profile, withDefault) {
  const home = path.join(directory, withDefault ? 'fixed-home' : 'baseline-home');
  const config = path.join(home, '.codex');
  const tmp = path.join(home, 'tmp');
  await fs.mkdir(config, { recursive: true, mode: 0o700 });
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  const args = ['-c', profile.argument];
  if (withDefault) args.push('-c', 'default_permissions=' + JSON.stringify(profile.id));
  args.push('app-server');
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-p', '(version 1)(allow default)(deny network*)', executable, ...args],
    {
      cwd: view.readRoot,
      env: {
        PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        HOME: home,
        CODEX_HOME: config,
        TMPDIR: tmp,
        LANG: 'C',
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '',
    initialized = false,
    rpcError = false,
    rpcErrorDetail,
    timedOut = false,
    spawnFailed = false;
  const kill = (signal) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {}
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    kill('SIGKILL');
  }, 20000);
  const lines = readline.createInterface({ input: child.stdout });
  const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-16384);
  });
  lines.on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    if (reply.method) return;
    if (reply.id === 1) {
      if (reply.error) {
        rpcError = true;
        rpcErrorDetail = String(reply.error.message || '')
          .replaceAll(directory, '[probe]')
          .slice(0, 1000);
        child.stdin.end();
        return;
      }
      initialized = true;
      send({ method: 'initialized', params: {} });
      child.stdin.end();
    }
  });
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', resolve);
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'buro_offline_verification', version: '1' },
        capabilities: { experimentalApi: true },
      },
    });
  }).finally(() => {
    clearTimeout(timeout);
    lines.close();
    kill('SIGKILL');
  });
  return {
    withDefault,
    exitCode,
    initialized,
    rpcError,
    ...(rpcErrorDetail ? { rpcErrorDetail } : {}),
    timedOut,
    spawnFailed,
    missingDefaultError:
      /config defines .*permissions.*profiles but does not set .*default_permissions/.test(stderr),
  };
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This offline probe requires macOS sandbox-exec.');
  const executable = (await exec('/usr/bin/which', ['codex'])).stdout.trim();
  const { EnvironmentExecutors } = await import('../adapters/environments/executors.ts');
  const { nativeVerificationPolicy } = await import('../adapters/codex/verification-policy.ts');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buro-native-startup-')));
  const executors = new EnvironmentExecutors();
  try {
    const source = path.join(root, 'source'),
      input = path.join(root, 'input'),
      output = path.join(root, 'output');
    await Promise.all([source, input, output].map((dir) => fs.mkdir(dir)));
    const view = {
      version: 1,
      id: 'offline-startup',
      projectId: 'probe',
      runId: 'probe',
      sourceWorkspace: source,
      readRoot: input,
      outputRoot: output,
      base: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      outputPaths: [],
    };
    await executors.registerVerification(view, new AbortController().signal);
    const profile = nativeVerificationPolicy(view, executors.verificationPolicy(view), source);
    const baseline = await probe(executable, root, view, profile, false);
    const fixed = await probe(executable, root, view, profile, true);
    const report = {
      offlineNetworkDenied: true,
      modelTurns: 0,
      threadStartSent: false,
      coverage:
        'Installed CLI config and initialize only; acknowledgement requires separate wire/live proof.',
      baseline,
      fixed,
    };
    console.log(JSON.stringify(report, null, 2));
    assert.equal(baseline.missingDefaultError, true);
    assert.equal(baseline.initialized, false);
    assert.equal(baseline.exitCode, 1);
    assert.equal(fixed.initialized, true);
    assert.equal(fixed.exitCode, 0);
    assert.equal(fixed.timedOut, false);
    assert.equal(fixed.rpcError, false);
    executors.releaseVerification(view);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    error instanceof assert.AssertionError ? error.message : 'Offline startup probe failed.',
  );
  process.exitCode = 1;
});
