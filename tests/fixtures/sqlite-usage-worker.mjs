import { SqliteProjectUsageAuthority } from '../../adapters/sqlite/project-usage-authority.ts';

const [directory, projectId, mode, commandId, fingerprint, operationId] = process.argv.slice(2);
const owner = { kind: 'run', runId: 'run' };
const authority = await SqliteProjectUsageAuthority.open({
  directory,
  project: { id: projectId, name: 'Synthetic project', root: directory },
});
let callbackCalls = 0;
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
function barrier(type) {
  process.send({ type });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  throw Error('The parent did not terminate the crash fixture.');
}
async function run() {
  try {
    const result = await authority.transaction({ id: commandId, fingerprint }, (tx) => {
      callbackCalls++;
      const current = tx.usage.account(owner);
      const decision = tx.usage.admitGeneration(owner, {
        accountId: current.id,
        operationId,
        phase: 'work',
        requestedOutputTokens: 100,
        minimumOutputTokens: 1,
      });
      if (decision.kind === 'denied') throw Error(decision.code);
      if (mode === 'before-commit') barrier('before-commit');
      return { kind: decision.kind, grant: decision.grant };
    });
    if (mode === 'after-commit') barrier('after-commit');
    await send({ type: 'result', ok: true, callbackCalls, result });
  } catch (error) {
    await send({
      type: 'result',
      ok: false,
      callbackCalls,
      code: error.code,
      message: error.message,
    });
  } finally {
    await authority.close();
    process.disconnect();
  }
}
if (mode === 'contend') {
  process.once('message', () => void run());
  await send({ type: 'ready' });
} else await run();
