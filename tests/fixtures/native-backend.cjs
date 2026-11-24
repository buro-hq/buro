const readline = require('node:readline');
if (process.argv.includes('mcp')) {
  console.log('[]');
  process.exit(0);
}
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') {
    if (!message.params.dynamicTools.some((tool) => tool.name === 'save'))
      throw new Error('Missing host tool');
    send({
      id: message.id,
      result: {
        thread: { id: 'native-thread' },
        model: 'fixture',
        activePermissionProfile: { id: 'buro_tool_host' },
      },
    });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'native-turn' } } });
    send({
      id: 'tool-request',
      method: 'item/tool/call',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        callId: 'native-call',
        tool: 'save',
        arguments: {},
      },
    });
  }
  if (message.id === 'tool-request') {
    if (!message.result?.success || message.result?.contentItems[0]?.text !== 'Saved by host')
      throw new Error('Host tool did not complete');
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'native-thread', delta: 'Done by native' },
    });
    send({
      method: 'item/completed',
      params: { threadId: 'native-thread', item: { type: 'agentMessage', text: 'Done by native' } },
    });
    send({
      method: 'turn/completed',
      params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } },
    });
  }
});
