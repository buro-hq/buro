import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
let initialized = false,
  turn = 0;
for await (const line of lines) {
  const m = JSON.parse(line);
  if (m.method === 'initialized') continue;
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  if (m.method === 'initialize') {
    initialized = true;
    send({ id: m.id, result: { serverInfo: 'fixture' } });
  } else if (!initialized) send({ id: m.id, error: { message: 'Not initialized' } });
  else if (m.method === 'thread/resume')
    send({ id: m.id, result: { thread: { id: m.params.threadId } } });
  else if (m.method === 'thread/start')
    send({ id: m.id, result: { thread: { id: 'fixture-thread' } } });
  else if (m.method === 'turn/start') {
    const id = 'fixture-turn-' + ++turn;
    send({ id: m.id, result: { turn: { id } } });
    send({ method: 'turn/started', params: { threadId: m.params.threadId } });
    if (m.params.input?.[0]?.text === 'idle') {
      continue;
    }
    if (m.params.input?.[0]?.text === 'long-active') {
      send({
        method: 'item/completed',
        params: {
          threadId: m.params.threadId,
          turnId: id,
          item: {
            id: 'spawn',
            type: 'subAgentActivity',
            kind: 'started',
            agentThreadId: 'child-thread',
          },
        },
      });
      for (let tick = 1; tick <= 8; tick++)
        setTimeout(
          () =>
            send({
              method: 'item/agentMessage/delta',
              params: { threadId: 'child-thread', delta: 'progress' },
            }),
          tick * 100,
        );
      setTimeout(() => {
        send({
          method: 'item/completed',
          params: {
            threadId: m.params.threadId,
            turnId: id,
            item: { id: 'answer-long', type: 'agentMessage', text: 'done' },
          },
        });
        send({
          method: 'turn/completed',
          params: { threadId: m.params.threadId, turn: { id, status: 'completed' } },
        });
      }, 900);
      continue;
    }
    if (m.params.outputSchema) {
      send({
        method: 'item/completed',
        params: {
          threadId: m.params.threadId,
          turnId: id,
          item: {
            id: 'answer-' + turn,
            type: 'agentMessage',
            text: JSON.stringify({ answer: turn, sandbox: m.params.sandboxPolicy.type }),
          },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: m.params.threadId, turn: { id, status: 'completed' } },
      });
    }
  } else if (m.method === 'turn/interrupt') send({ id: m.id, result: {} });
}
