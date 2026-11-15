import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { selectSession } = await import(
  pathToFileURL(path.join(process.env.GOAL_WORKSPACE, 'experiments/goals/catalog.mjs'))
);
const results = [],
  sessions = Object.freeze([
    Object.freeze({ id: '001' }),
    Object.freeze({ id: '010' }),
    Object.freeze({ id: '002' }),
  ]);
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (e) {
    results.push({ name, passed: false, error: e.message });
  }
}
check('explicit id returns exact object', () =>
  assert.equal(selectSession(sessions, '001'), sessions[0]),
);
check('omitted id selects newest valid session', () =>
  assert.equal(selectSession([null, ...sessions]), sessions[1]),
);
check('missing id fails without fallback', () =>
  assert.throws(() => selectSession(sessions, 'missing'), /not found/i),
);
check('unsafe id is rejected', () => {
  for (const id of ['../001', 'a/b', '', 42])
    assert.throws(() => selectSession(sessions, id), /invalid/i);
});
check('empty collection fails clearly', () =>
  assert.throws(() => selectSession([]), /no sessions/i),
);
console.log(JSON.stringify({ results }));
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
