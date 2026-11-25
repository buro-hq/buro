import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../modules/application/create-application.ts';
import fixture from '../scripts/fixtures/ready-queue.json' with { type: 'json' };

test(
  'live evaluation reports an unfinished claim as a failing test without changing agent completion, and verifies a real tool fix',
  {
    timeout: 30000,
  },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-evaluation-cli-'));
    const outputs: string[] = [];
    let mode = 'claim';
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string }[];
      };
      const fixing = mode === 'fix' && !body.messages.some((message) => message.role === 'tool');
      const delta = fixing
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'priority',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'src/priority.mjs',
                    content: fixture.files['src/priority.mjs'].replace(
                      'task.priority || 2',
                      'task.priority ?? 2',
                    ),
                  }),
                },
              },
              {
                index: 1,
                id: 'queue',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'src/queue.mjs',
                    content: fixture.files['src/queue.mjs'].replace('.some(', '.every('),
                  }),
                },
              },
            ],
          }
        : { content: 'Done' };
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
      });
      response.end(
        'data: ' +
        JSON.stringify({
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason: fixing ? 'tool_calls' : 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const output of outputs)
        await fs.rm(output, {
          recursive: true,
          force: true,
        });
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const app = await createApplication({
      directory,
    });
    await app.modelConfigurations.save({
      configuration: {
        id: 'fixture',
        name: 'Fixture',
        transport: 'openai-compatible',
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: 'fixture',
        local: true,
      },
      default: true,
    });
    await app.close();
    for (mode of ['claim', 'fix']) {
      let stdout: string;
      let code = 0;
      try {
        stdout = (
          await promisify(execFile)(
            process.execPath,
            ['scripts/evaluate-model.ts', 'queue', 'fixture'],
            {
              env: { ...process.env, PROJECT_DATA_DIR: directory },
              maxBuffer: 1024 * 1024,
            },
          )
        ).stdout;
      } catch (error) {
        code = (error as { code: number }).code;
        stdout = (error as { stdout: string }).stdout;
      }
      const finished = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((value) => value.finished === true);
      assert.ok(finished, stdout);
      const output = path.dirname(finished.report);
      outputs.push(output);
      const report = JSON.parse(await fs.readFile(finished.report, 'utf8'));
      assert.equal(report.run.status, 'completed');
      assert.equal(report.scope.passed, true);
      assert.equal(code, mode === 'fix' ? 0 : 1);
      assert.equal(report.verification.public.passed, mode === 'fix' ? 3 : 0);
      assert.equal(report.verification.holdout.passed, mode === 'fix' ? 5 : 3);
    }
  },
);
