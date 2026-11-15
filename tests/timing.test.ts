import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, Agent } from '../protocol/domain.ts';
import {
  activeDuration,
  agentActiveDuration,
  agentIntervals,
  executionIntervals,
  skipInactiveTime,
  wallDuration,
  wallTimeAtActive,
} from '../protocol/timing.ts';
import { agentState } from '../src/model.ts';
const date = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
function fixture() {
  const agent: Agent = {
    threadId: 'a',
    name: 'developer',
    agentPath: '/root/developer',
    startedAt: date(10),
    completedAt: date(620),
    status: 'completed',
    messages: [],
    commands: 0,
  };
  const run = {
    createdAt: date(0),
    completedAt: date(630),
    status: 'completed',
    agents: [agent],
    events: [
      { at: date(0), type: 'run.queued' },
      { at: date(10), type: 'agent.started', threadId: 'a' },
      { at: date(20), type: 'agent.completed', threadId: 'a' },
      { at: date(30), type: 'run.failed' },
      { at: date(600), type: 'run.resume-requested' },
      { at: date(610), type: 'message', threadId: 'a' },
      { at: date(620), type: 'agent.turn-completed', threadId: 'a' },
      { at: date(630), type: 'goal.completed' },
    ],
  } as Run;
  return { run, agent };
}
test('resumed workflow excludes stopped time without summing parallel agents', () => {
  const { run } = fixture();
  assert.equal(wallDuration(run), 630);
  assert.equal(activeDuration(run), 60);
  assert.equal(activeDuration(run, 300), 30);
  assert.equal(activeDuration(run, 605), 35);
  assert.deepEqual(executionIntervals(run), [
    { start: 0, end: 30 },
    { start: 600, end: 630 },
  ]);
  run.agents.push({ ...run.agents[0], threadId: 'b' });
  assert.equal(activeDuration(run), 60);
});
test('reused agent has separate work intervals; overwritten completedAt never bridges the pause', () => {
  const { run, agent } = fixture();
  assert.equal(agentActiveDuration(run, agent), 20);
  const intervals = agentIntervals(run, agent);
  assert.deepEqual(
    intervals.map(({ start, end }) => ({ start, end })),
    [
      { start: 10, end: 20 },
      { start: 610, end: 620 },
    ],
  );
  assert.equal(intervals[1].estimated, true);
  assert.equal(agentState(run, agent, 15), 'working');
  assert.equal(agentState(run, agent, 300), 'done');
  assert.equal(agentState(run, agent, 615), 'working');
  assert.equal(agentState(run, agent, 630), 'done');
});
test('playback skips human pauses while retaining wall-clock event coordinates', () => {
  const { run } = fixture();
  assert.equal(skipInactiveTime(run, 29), 29);
  assert.equal(skipInactiveTime(run, 31), 600);
  assert.equal(skipInactiveTime(run, 605), 605);
  assert.equal(skipInactiveTime(run, 1000), 630);
});
test('late repeated completion does not invent a new agent interval', () => {
  const { run, agent } = fixture();
  run.events = run.events.filter((e) => e.type !== 'message');
  assert.equal(agentActiveDuration(run, agent), 10);
});
test('explicit resumed turn starts provide an exact interval instead of a legacy estimate', () => {
  const { run, agent } = fixture();
  run.events.splice(5, 0, { at: date(605), type: 'agent.turn-started', threadId: 'a' });
  assert.equal(agentActiveDuration(run, agent), 25);
  assert.equal(agentIntervals(run, agent)[1].estimated, undefined);
});
test('historical recordings without lifecycle events retain their original single duration', () => {
  const { run, agent } = fixture();
  run.events = [];
  assert.equal(activeDuration(run), 630);
  assert.equal(agentActiveDuration(run, agent), 610);
});

test('slider maps execution time back to the correct attempt on the wall clock', () => {
  const { run } = fixture();
  assert.equal(wallTimeAtActive(run, 15), 15);
  assert.equal(wallTimeAtActive(run, 35), 605);
  assert.equal(wallTimeAtActive(run, 60), 630);
});
