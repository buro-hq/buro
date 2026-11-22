import type { Run } from '../protocol/domain.ts';
import type { RuntimeEvent } from './runtime-events.ts';

/** Mutates only a transaction draft; clocks and storage belong to the caller. */
export function applyRuntimeEvent(run: Run, event: RuntimeEvent, now: string) {
  const tid = event.threadId;
  if (event.type === 'agent.activity') {
    if (tid === run.threadId) return;
    let child = run.agents.find((a) => a.threadId === tid);
    if (!child) {
      // Undeclared native children remain visible, but cannot impersonate an assignment.
      const hints = event.activityHints;
      const name = 'native:' + (hints?.name || 'worker');
      child = {
        threadId: tid,
        name,
        agentPath: hints?.path || '/root/' + name,
        startedAt: now,
        completedAt: '',
        messages: [],
        commands: 0,
        status: 'running',
      };
      run.agents.push(child);
      run.events.push({
        at: now,
        type: 'agent.started',
        threadId: tid,
        text: hints?.prompt || name,
      });
    }
    if (child.session) return;
    if (event.completed && child.status !== 'completed') {
      child.status = 'completed';
      child.completedAt = now;
      run.events.push({
        at: now,
        type: 'agent.completed',
        threadId: tid,
        text: event.message || 'Child agent completed work',
      });
    }
    return;
  }
  const agent = run.agents.find((a) => a.threadId === tid);
  if (event.type === 'segment.started' || event.type === 'segment.completed') {
    run.events.push({
      at: now,
      type: 'agent.' + event.type,
      threadId: tid,
      text: String(event.segmentIndex),
    });
    // A conversation window is not a logical worker completion or acceptance receipt.
    return;
  }
  if (event.type === 'tool.started' || event.type === 'tool.completed') {
    run.events.push({
      at: now,
      type: event.type,
      threadId: tid,
      text: event.toolName + (event.type === 'tool.completed' && event.isError ? ': failed' : ''),
    });
  }
  if (event.type === 'message.completed') {
    const text = event.text.slice(0, 12000);
    agent?.messages.push(text);
    run.events.push({ at: now, type: 'message', threadId: tid, text });
  }
  if (event.type === 'command.started' || event.type === 'command.completed') {
    let command = run.commands.find((c) => c.id === event.commandId && c.threadId === tid);
    if (!command) {
      command = { id: event.commandId, threadId: tid, command: event.command, startedAt: now };
      run.commands.push(command);
      if (agent) agent.commands++;
      run.events.push({
        at: now,
        type: 'command.started',
        threadId: tid,
        commandId: command.id,
        text: command.command,
      });
    }
    if (event.type === 'command.completed') {
      command.completedAt = now;
      command.exitCode = event.exitCode;
      command.output = event.output.slice(-30000);
      run.events.push({
        at: now,
        type: 'command.completed',
        threadId: tid,
        commandId: command.id,
        text: command.command,
      });
    }
  }
  if (event.type === 'turn.started' && agent && agent.name !== 'reviewer') {
    agent.status = 'running';
    agent.completedAt = '';
    run.events.push({ at: now, type: 'agent.turn-started', threadId: tid });
  }
  if (event.type === 'turn.completed' && agent && agent.name !== 'reviewer') {
    agent.status = event.status;
    agent.completedAt = now;
    run.events.push({ at: now, type: 'agent.turn-completed', threadId: tid, text: agent.status });
  }
}
