import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { startApiServer } from '../../modules/api/server.ts';
import { localPort } from '../fixtures/local-port.ts';
import { presetApplication } from '../fixtures/preset-application.ts';

const choose = async (input: { page: Page; label: string; option: string }): Promise<void> => {
  const { page, label, option } = input;
  await page.getByRole('textbox', {
    name: label,
    exact: true,
  }).click();
  await page.getByRole('option', {
    name: option,
    exact: true,
  }).click();
};

const navigate = async (input: { page: Page; name: string }): Promise<void> => {
  const { page, name } = input;
  await page.locator('.sidebar').getByRole('button', {
    name,
    exact: true,
  }).click();
};

test('UI creates, edits, selects and adjusts a preset, launches ordinary runs and deletes the saved preset', {
  timeout: 90000,
}, async (t) => {
  const f = await presetApplication(t);
  const api = await startApiServer({
    application: f.app,
    token: 'preset-ui-test',
    port: 0,
  });
  t.after(() => api.close());
  const vite = await createServer({
    cacheDir: path.join(f.directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: await localPort(), open: false },
    plugins: [{
      name: 'preset-ui-entry',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__presets.html')
            return next();

          try {
            const html = await server.transformIndexHtml('/__presets.html', `<!doctype html><html><body><div id="root"></div><script type="module">
              import '@mantine/core/styles.css'; import '/src/styles.css'; import '/src/styles/features.css';
              import React from 'react'; import {createRoot} from 'react-dom/client'; import {Application} from '/src/Application.tsx';
              import {AppearanceProvider} from '/src/theme/AppearanceProvider.tsx'; import {ApplicationProvider} from '/src/data/application.tsx';
              createRoot(document.getElementById('root')).render(React.createElement(AppearanceProvider,null,React.createElement(ApplicationProvider,{url:'ws://127.0.0.1:${api.port}'},React.createElement(Application))));
            </script></body></html>`);
            response.setHeader('Content-Type', 'text/html');
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    }],
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
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__presets.html#buro-token=preset-ui-test`);
  await navigate({
    page,
    name: 'Launch presets',
  });
  await expect(page.getByText('No launch presets yet', {
    exact: true,
  })).toBeVisible();
  await page.getByRole('button', {
    name: 'New launch preset',
    exact: true,
  }).click();
  await page.getByRole('textbox', {
    name: 'Preset name',
    exact: true,
  }).fill('My launch');
  await choose({
    page,
    label: 'Model',
    option: 'Preset model',
  });
  await page.getByLabel('Override instructions', {
    exact: true,
  }).check();
  await choose({
    page,
    label: 'Automatic team review',
    option: 'Disabled',
  });
  await page.getByRole('button', {
    name: 'Add reviewer',
    exact: true,
  }).click();
  await page.getByLabel('Reviewer name', {
    exact: true,
  }).fill('Editable reviewer');
  await page.getByLabel('Review focus', {
    exact: true,
  }).fill('Saved focus');
  await choose({
    page,
    label: 'Reviewer model',
    option: 'Preset model',
  });
  await page.getByRole('button', {
    name: 'Save preset',
    exact: true,
  }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('My launch', {
    exact: true,
  })).toBeVisible();
  const original = (await f.app.presets.list({}))[0];
  assert.equal(original.options.instructions, '');
  assert.equal(original.options.review?.enabled, false);
  assert.equal(original.options.modelId, f.modelId);
  assert.equal(original.options.review?.participants?.[0].modelId, f.modelId);

  await page.getByRole('button', {
    name: 'Edit',
    exact: true,
  }).click();
  await page.getByRole('textbox', {
    name: 'Preset name',
    exact: true,
  }).fill('Updated launch');
  await page.getByLabel('Review focus', {
    exact: true,
  }).fill('Updated focus');
  await page.getByRole('button', {
    name: 'Save preset',
    exact: true,
  }).click();
  await expect(page.getByText('Updated launch', {
    exact: true,
  })).toBeVisible();
  const saved = (await f.app.presets.list({}))[0];
  assert.equal(saved.id, original.id);
  assert.equal(saved.options.review?.participants?.[0].instructions, 'Updated focus');

  await navigate({
    page,
    name: 'Goals',
  });
  await choose({
    page,
    label: 'Launch preset',
    option: 'Updated launch',
  });
  await expect(page.getByRole('textbox', {
    name: 'Model',
    exact: true,
  })).toHaveValue('Preset model');
  await page.getByRole('button', {
    name: 'Run options',
    exact: true,
  }).click();
  await expect(page.getByLabel('Override instructions', {
    exact: true,
  })).toBeChecked();
  await expect(page.getByLabel('Instructions override', {
    exact: true,
  })).toHaveValue('');
  await expect(page.getByRole('textbox', {
    name: 'Automatic team review',
    exact: true,
  })).toHaveValue('Disabled');
  await expect(page.getByLabel('Review focus', {
    exact: true,
  })).toHaveValue('Updated focus');
  await page.getByLabel('Instructions override', {
    exact: true,
  }).fill('Edited instructions');
  await page.getByLabel('Instructions override', {
    exact: true,
  }).fill('');
  await page.getByLabel('Reviewer name', {
    exact: true,
  }).fill('Launch-only reviewer');
  await page.getByLabel('Review focus', {
    exact: true,
  }).fill('Launch-only focus');
  await f.app.presets.save({
    id: saved.id,
    name: 'Changed elsewhere',
    options: { instructions: 'New saved instructions' },
  });
  await expect(page.getByRole('textbox', {
    name: 'Launch preset',
    exact: true,
  })).toHaveValue('Changed elsewhere');
  await expect(page.getByLabel('Instructions override', {
    exact: true,
  })).toHaveValue('');
  await expect(page.getByLabel('Reviewer name', {
    exact: true,
  })).toHaveValue('Launch-only reviewer');
  await page.getByRole('button', {
    name: 'Start run',
    exact: true,
  }).click();
  await expect.poll(async () => (await f.app.runs.list()).length).toBe(1);
  const first = (await f.app.runs.list())[0];
  await f.app.runs.wait({
    id: first.id,
  });
  await expect(page.getByText('Preset launch completed.', {
    exact: true,
  }).first()).toBeVisible();
  assert.notEqual(first.workspace, f.root);
  assert.deepEqual(first.options, {
    modelId: f.modelId,
    instructions: '',
    review: { enabled: false, participants: [{ name: 'Launch-only reviewer', instructions: 'Launch-only focus', modelId: f.modelId }] },
  });
  assert.equal(first.review, undefined);
  assert.equal((await f.app.sessions.get({
    id: first.sessionId,
  }))!.instructions, '');
  assert.equal((await f.app.sessions.get({
    id: first.sessionId,
  }))!.policy, 'Application instructions');
  assert.equal((await f.app.presets.get({
    id: saved.id,
  }))!.options.instructions, 'New saved instructions');

  await navigate({
    page,
    name: 'Goals',
  });
  await choose({
    page,
    label: 'Launch preset',
    option: 'Changed elsewhere',
  });
  await page.getByRole('button', {
    name: 'Run options',
    exact: true,
  }).click();
  await expect(page.getByLabel('Instructions override', {
    exact: true,
  })).toHaveValue('New saved instructions');
  const clearPreset = page.getByRole('button', {
    name: 'Clear preset',
    exact: true,
  });
  await page.getByRole('textbox', {
    name: 'Launch preset',
    exact: true,
  }).focus();
  await page.keyboard.press('Tab');
  await expect(clearPreset).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Override instructions', {
    exact: true,
  })).not.toBeChecked();
  await expect(page.getByRole('textbox', {
    name: 'Model',
    exact: true,
  })).toHaveValue('');
  await page.getByRole('button', {
    name: 'Start run',
    exact: true,
  }).click();
  await expect.poll(async () => (await f.app.runs.list()).length).toBe(2);
  const second = (await f.app.runs.list())[1];
  await f.app.runs.wait({
    id: second.id,
  });
  await expect(page.getByText('Preset launch completed.', {
    exact: true,
  }).first()).toBeVisible();
  assert.deepEqual(second.options, {});
  assert.equal((await f.app.sessions.get({
    id: second.sessionId,
  }))!.policy, 'Application instructions');

  await navigate({
    page,
    name: 'Launch presets',
  });
  await page.getByRole('button', {
    name: 'Delete',
    exact: true,
  }).click();
  await expect(page.getByText('No launch presets yet', {
    exact: true,
  })).toBeVisible();
  assert.equal(await f.app.presets.get({
    id: saved.id,
  }), undefined);
  assert.deepEqual((await f.app.runs.get({
    id: first.id,
  }))!.options, first.options);
  assert.equal((await f.app.settings.get()).instructions, 'Application instructions');
  await navigate({
    page,
    name: 'Goals',
  });
  await expect(page.getByText('No launch presets yet', {
    exact: true,
  })).toBeVisible();
  assert.deepEqual(errors, []);
});
