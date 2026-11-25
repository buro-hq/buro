import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createApplication } from '../modules/application/create-application.ts';
import { startApiServer } from '../modules/api/server.ts';
import { localPort } from './fixtures/local-port.ts';

const exec = promisify(execFile);

test(
  'feature UI connects a project, edits intent, runs an agent, reads its conversation and explicitly applies isolated changes',
  {
    timeout: 90000,
  },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-feature-ui-'));
    const root = path.join(directory, 'source');
    t.after(() => fs.rm(directory, {
      recursive: true,
      force: true,
    }));
    await fs.mkdir(root);
    await exec('git', ['init', '-q', root]);
    await fs.writeFile(path.join(root, 'README.md'), 'Initial\n');
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
    const app = await createApplication({
      directory: path.join(directory, 'state'),
      transports: [
        {
          id: 'fixture',
          create({ configuration }) {
            return {
              id: configuration.id,
              revision: configuration.revision,
              async complete(request) {
                if (!request.messages.some((message) => message.role === 'tool'))
                  return {
                    model: 'fixture',
                    finish: 'tools',
                    message: {
                      role: 'assistant',
                      content: '',
                      toolCalls: [
                        {
                          id: 'write-file',
                          name: 'write_file',
                          arguments: {
                            path: 'result.txt',
                            content: 'Finished through the common tool loop\n',
                          },
                        },
                      ],
                    },
                  };

                const observed = request.messages.filter(
                  (message) => message.role === 'tool',
                ).length;
                if (observed < 28)
                  return {
                    model: 'fixture',
                    finish: 'tools',
                    message: {
                      role: 'assistant',
                      content: '',
                      toolCalls: [
                        { id: 'observe-' + observed, name: 'fixture_observe', arguments: {} },
                      ],
                    },
                  };

                assert.equal(
                  await fs.readFile(path.join(request.workspace, 'result.txt'), 'utf8'),
                  'Finished through the common tool loop\n',
                );
                return {
                  model: 'fixture',
                  finish: 'stop',
                  message: { role: 'assistant', content: 'The requested file is ready.' },
                  usage: { inputTokens: 20, outputTokens: 10 },
                };
              },
            };
          },
        },
      ],
    });
    t.after(() => app.close());
    app.tools.register({
      effect: 'read',
      definition: { name: 'fixture_observe', description: 'Observe fixture state', parameters: {} },
      async execute() {
        return { content: 'Fixture observed' };
      },
    });
    const model = await app.modelConfigurations.save({
      configuration: { name: 'Fixture model', transport: 'fixture', model: 'fixture' },
    });
    assert.equal(model.ok, true);
    const api = await startApiServer({
      application: app,
      token: 'test-ui-token',
      port: 0,
    });
    t.after(() => api.close());
    const vite = await createServer({
      cacheDir: path.join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: await localPort(), open: false },
      plugins: [
        {
          name: 'feature-client-test-entry',
          configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
              if (request.url?.split('?')[0] !== '/__features.html')
                return next();

              try {
                const html = await server.transformIndexHtml(
                  '/__features.html',
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
          import '@mantine/core/styles.css'; import '/src/styles.css'; import '/src/styles/features.css';
          import React from 'react'; import {createRoot} from 'react-dom/client'; import {Application} from '/src/Application.tsx';
          import {AppearanceProvider} from '/src/theme/AppearanceProvider.tsx'; import {ApplicationProvider} from '/src/data/application.tsx';
          createRoot(document.getElementById('root')).render(React.createElement(AppearanceProvider,null,React.createElement(ApplicationProvider,{url:'ws://127.0.0.1:${api.port}'},React.createElement(Application))));
        </script></body></html>`,
                );
                response.setHeader('Content-Type', 'text/html');
                response.end(html);
              } catch (error) {
                next(error);
              }
            });
          },
        },
      ],
    });
    t.after(() => vite.close());
    await vite.listen();
    const address = vite.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__features.html#buro-token=test-ui-token`);
    await page
      .locator('main')
      .getByRole('button', {
        name: 'Connect project',
        exact: true,
      })
      .click();
    await page.getByRole('textbox', {
      name: 'Project directory',
      exact: true,
    }).fill(root);
    await page
      .getByRole('dialog')
      .getByRole('button', {
        name: 'Connect project',
        exact: true,
      })
      .click();
    await page.locator('.sidebar').getByRole('button', {
      name: 'Goals',
      exact: true,
    }).click();
    await page.getByRole('button', {
      name: 'New goal',
      exact: true,
    }).click();
    await page
      .getByRole('textbox', {
        name: 'What should we achieve?',
        exact: true,
      })
      .fill('Create a result file');
    await page
      .getByRole('textbox', {
        name: 'Context and expected result',
        exact: true,
      })
      .fill('Write result.txt with the requested text');
    await page.getByRole('button', {
      name: 'Save and start',
      exact: true,
    }).click();
    await expect(
      page.getByText('The requested file is ready.', {
        exact: true,
      }).first(),
    ).toBeVisible();
    await expect(page.getByText('Reported tokens', {
      exact: false,
    })).toBeVisible();
    // Reopening starts with the recent page; an already open view retains its earlier messages.
    await page.getByRole('button', {
      name: 'All runs',
      exact: true,
    }).click();
    await page.getByRole('button', {
      name: 'Open',
      exact: true,
    }).click();
    await expect(
      page.getByRole('button', {
        name: 'Load earlier messages',
        exact: true,
      }),
    ).toBeVisible();
    const originalTask = page
      .locator('pre.feature-pre')
      .filter({
        hasText: 'Write result.txt with the requested text',
      });
    await expect(originalTask).toHaveCount(0);
    await page.getByRole('button', {
      name: 'Load earlier messages',
      exact: true,
    }).click();
    await expect(originalTask).toHaveCount(1);
    await expect(
      page.getByRole('button', {
        name: 'Load earlier messages',
        exact: true,
      }),
    ).toHaveCount(0);
    await assert.rejects(fs.access(path.join(root, 'result.txt')));
    await page.getByRole('tab', {
      name: 'Changes',
      exact: true,
    }).click();
    const changedFile = page.getByRole('group', {
      name: 'result.txt',
      exact: true,
    });
    await expect(changedFile.getByText('result.txt', {
      exact: true,
    })).toBeVisible();
    await expect(changedFile.getByText('Added', {
      exact: true,
    })).toBeVisible();
    await page.getByRole('button', {
      name: 'Apply changes to project',
      exact: true,
    }).click();
    await expect
      .poll(() => fs.readFile(path.join(root, 'result.txt'), 'utf8').catch(() => ''))
      .toBe('Finished through the common tool loop\n');
    await page.locator('.sidebar').getByRole('button', {
      name: 'Models',
      exact: true,
    }).click();
    await expect(page.getByText('Fixture model', {
      exact: true,
    })).toBeVisible();
    await fs.mkdir('artifacts/architecture-refactor', {
      recursive: true,
    });
    await page.screenshot({
      path: 'artifacts/architecture-refactor/models-desktop.png',
    });
    await page.setViewportSize({
      width: 390,
      height: 844,
    });
    await page.getByRole('button', {
      name: 'Navigation',
      exact: true,
    }).click();
    await expect(
      page.getByRole('dialog').getByRole('button', {
        name: 'Agents',
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
  },
);
