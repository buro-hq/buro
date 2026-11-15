import { agentState, counts, duration, isTerminal, lastTest, phase, type Run } from '../../model';
export function getRunViewState(run: Run, cursor: number) {
  const end = duration(run),
    complete = isTerminal(run) && cursor >= end - 0.05;
  const test = lastTest(run, cursor);
  return {
    end,
    complete,
    currentPhase: phase(run, cursor),
    active: run.agents.filter((agent) => agentState(run, agent, cursor) === 'working').length,
    test,
    testCounts: counts(test?.output),
  };
}
