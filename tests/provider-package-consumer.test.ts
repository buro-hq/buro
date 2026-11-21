import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('compiled provider entry works in a standalone consumer without repository source, ambient fetch or Codex', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-provider-consumer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const part of ['contracts', 'providers'])
    await fs.cp(path.resolve('agent', part), path.join(directory, 'source', part), {
      recursive: true,
    });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        types: [],
        rewriteRelativeImportExtensions: true,
        rootDir: 'source',
        outDir: 'dist',
        erasableSyntaxOnly: true,
      },
      include: ['source/contracts/*.ts', 'source/providers/*.ts'],
    }),
  );
  const compiler = path.resolve('node_modules/typescript/bin/tsc');
  await execute(
    process.execPath,
    [compiler, '--project', path.join(directory, 'tsconfig.json'), '--pretty', 'false'],
    { cwd: directory },
  );
  // The consumer below can only load the compiled artifact; all TypeScript sources are gone.
  await fs.rm(path.join(directory, 'source'), { recursive: true });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['dist', 'package.json', 'tsconfig.json']);
  const script = `
import assert from 'node:assert/strict';
import { OllamaProvider, DeepSeekProvider, ProviderFailure, providerFailureOutcome } from './dist/providers/index.js';
assert.equal(process.env.PATH, '');
assert.equal(process.env.CODEX_HOME, undefined);
assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
let ambientRequests = 0;
globalThis.fetch = async () => { ambientRequests++; throw Error('No ambient networking'); };
let requests = 0;
const injectedFetch = async (url, init) => {
  requests++;
  const request = JSON.parse(init.body);
  assert.equal(request.stream, true);
  const route = new URL(String(url)).pathname;
  if (route === '/api/chat') return new Response(JSON.stringify({ model: 'external-model', message: { role: 'assistant', content: 'portable' }, done: true, done_reason: 'stop' }) + '\\n');
  if (route === '/chat/completions') return new Response('data: ' + JSON.stringify({ model: 'external-model', choices: [{ index: 0, delta: { content: 'portable' }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n');
  throw Error('Unexpected endpoint');
};
const identity = { id: 'outside-buro', revision: 'consumer-revision', local: false, fetch: injectedFetch };
const providers = [new OllamaProvider({ ...identity, endpoint: 'http://127.0.0.1:11434' }), new DeepSeekProvider({ ...identity, endpoint: 'https://provider.invalid', apiKey: () => 'synthetic-consumer-key' })];
for (const provider of providers) {
  const events = [];
  const result = await provider.complete({ requestId: provider.id, model: 'external-model', messages: [{ role: 'user', content: 'Respond once' }], tools: [], schema: null, contextTokens: 4096, maxOutputTokens: 128, signal: new AbortController().signal, onProgress() {}, onEvent: (event) => events.push(event) });
  assert.equal(result.message.content, 'portable');
  assert.equal(result.finish, 'stop');
  assert.equal(result.usage, undefined);
  assert.equal(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join(''), 'portable');
  assert.deepEqual(events.at(-1), { type: 'response.completed', model: 'external-model', finish: 'stop' });
}
assert.equal(requests, 2);
assert.equal(ambientRequests, 0);
assert.equal(providerFailureOutcome(new ProviderFailure('MODEL_UNAVAILABLE', 'Fixture', { outcome: 'unknown' })), 'unknown');
console.log('standalone-provider-consumer-ok');
`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: directory,
    // Native clients, inherited API keys, Buro configuration and loader hooks are absent.
    env: { PATH: '' },
  });
  assert.equal(result.stdout.trim(), 'standalone-provider-consumer-ok');
  assert.equal(result.stderr, '');
});
