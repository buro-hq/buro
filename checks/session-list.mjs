import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { listSessions } = await import(
  pathToFileURL(path.join(process.env.GOAL_WORKSPACE, 'experiments/goals/catalog.mjs'))
);
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: e.message });
  }
}
check('descending ids without changing input', () => {
  const input = Object.freeze([
    Object.freeze({ id: '001', label: 'a' }),
    Object.freeze({ id: '010', label: 'b' }),
    Object.freeze({ id: '002', label: 'c' }),
  ]);
  const result = listSessions(input);
  assert.deepEqual(
    result.map((r) => r.id),
    ['010', '002', '001'],
  );
  assert.notEqual(result, input);
  assert.equal(result[0], input[1]);
});
check('malformed entries are skipped', () =>
  assert.deepEqual(
    listSessions([
      null,
      undefined,
      {},
      'hi',
      { id: 3 },
      { id: '' },
      { id: 'a/b' },
      { id: '..' },
      { id: 'good-1' },
      { id: 'ok_2' },
    ]).map((r) => r.id),
    ['ok_2', 'good-1'],
  ),
);
check('empty input and invalid collection', () => {
  assert.deepEqual(listSessions([]), []);
  assert.deepEqual(listSessions(null), []);
  assert.deepEqual(listSessions({}), []);
});
console.log(JSON.stringify({ results }));
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
