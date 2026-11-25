import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../modules/application/create-application.ts';
import type { Application } from '../modules/application/application.ts';
import type { Preview } from '../modules/previews/preview.ts';

const exec = promisify(execFile);

async function observed(input: { app: Application; id: string; status: string }): Promise<Preview> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const preview = await input.app.previews.get({
      id: input.id,
    });
    if (preview?.status === input.status)
      return preview;

    if (preview?.status === 'failed' || Date.now() > deadline)
      throw new Error(JSON.stringify(preview));

    await delay(25);
  }
}

test(
  'multiple optional previews outlive their completed run, expose logs, use independent ports and stop with their owner',
  {
    skip: process.platform !== 'darwin' && process.platform !== 'linux',
    timeout: 30000,
  },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-previews-'));
    const root = path.join(directory, 'source');
    const state = path.join(directory, 'state');
    let app: Application | undefined;
    t.after(async () => {
      await app?.close();
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    await fs.mkdir(root);
    await exec('git', ['init', '-q', root]);
    await fs.writeFile(
      path.join(root, 'server.mjs'),
      "import http from 'node:http'; http.createServer((req,res)=>res.end('preview:'+process.env.PREVIEW_VALUE)).listen(Number(process.env.PORT),process.env.HOST,()=>console.log('preview-started'));\n",
    );
    await exec('git', ['add', '.'], {
      cwd: root,
    });
    await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Initial',
      ],
      {
        cwd: root,
      },
    );
    app = await createApplication({
      directory: state,
    });
    app.models.register({
      id: 'fixture',
      name: 'Fixture',
      model: 'fixture',
      contextTokens: 32768,
      outputTokens: 8192,
      backend: {
        id: 'fixture',
        revision: 'one',
        async complete() {
          return {
            model: 'fixture',
            finish: 'stop',
            message: { role: 'assistant', content: 'Ready' },
          };
        },
      },
    });
    const project = (await app.projects.connect({
      root,
    })).project!;
    const task = await app.tasks.create({
      projectId: project.id,
      title: 'Preview',
      description: 'Run the server',
    });
    const run = (await app.runs.start({
      taskId: task.id,
    })).run!;
    assert.equal((await app.runs.wait({
      id: run.id,
    }))?.status, 'completed');
    const notices: unknown[] = [];
    app.events.subscribe((notice) => {
      notices.push(notice);
    });
    const started = await Promise.all(
      [1, 2].map(() =>
        app!.previews.start({
          runId: run.id,
          command: 'node server.mjs',
          env: { PREVIEW_VALUE: 'fixture-environment-value' },
        })),
    );
    assert.ok(started.every((result) => result.ok));
    const [first, second] = await Promise.all(
      started.map((result) => observed({
        app: app!,
        id: result.preview!.id,
        status: 'running',
      })),
    );
    assert.notEqual(first.port, second.port);
    assert.equal(await (await fetch(first.url!)).text(), 'preview:fixture-environment-value');
    assert.equal(await (await fetch(second.url!)).text(), 'preview:fixture-environment-value');
    assert.match((await app.previews.get({
      id: first.id,
    }))!.stdout!, /preview-started/);
    assert.ok(!JSON.stringify(await app.previews.list()).includes('fixture-environment-value'));
    assert.ok(!JSON.stringify(notices).includes('fixture-environment-value'));
    const busy = await app.previews.start({
      runId: run.id,
      command: 'node server.mjs',
      port: first.port,
    });
    assert.equal(busy.ok, false);
    await app.previews.stop({
      id: first.id,
    });
    assert.equal((await app.previews.get({
      id: first.id,
    }))!.status, 'stopped');
    assert.equal(await (await fetch(second.url!)).text(), 'preview:fixture-environment-value');
    await app.close();
    await assert.rejects(fetch(second.url!));
    app = await createApplication({
      directory: state,
    });
    assert.ok(
      (await app.previews.list()).every((preview) => preview.status === 'stopped' && !preview.url),
    );
  },
);
