import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { apiCredential } from '../modules/api/credentials.ts';
import { createApplication } from '../modules/application/create-application.ts';
import { localPort } from './fixtures/local-port.ts';

test(
  'the production launcher connects the real UI and CLI to a fresh service and releases ownership on shutdown',
  {
    timeout: 30000,
  },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-production-startup-'));
    const env = {
      ...process.env,
      PROJECT_DATA_DIR: directory,
      PROJECT_DAEMON_PORT: '0',
      BURO_UI_PORT: String(await localPort()),
      BURO_OPEN_BROWSER: '0',
    };
    const child = spawn(process.execPath, ['scripts/start-dev.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    t.after(async () => {
      await browser?.close();
      child.kill('SIGTERM');
      await exited;
      await fs.rm(directory, {
        recursive: true,
        force: true,
      });
    });
    const address = await new Promise<{ ui: string; api: string }>((resolve, reject) => {
      let output = '';
      let error = '';
      const timer = setTimeout(
        () => reject(new Error('Launcher did not become ready. ' + error)),
        15000,
      );
      child.on('error', reject);
      child.stderr.on('data', (bytes) => {
        error += bytes.toString();
      });
      child.stdout.on('data', (bytes) => {
        output += bytes.toString();
        const api = output.match(/Buro daemon: (ws:\/\/127\.0\.0\.1:\d+)/)?.[1];
        const ui = output.match(/Buro: (http:\/\/[^\s]+)/)?.[1];
        if (api && ui) {
          clearTimeout(timer);
          resolve({
            ui,
            api,
          });
        }
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Launcher exited. ' + error));
      });
    });
    const cliEnv = { ...env, PROJECT_DAEMON_URL: address.api };
    const status = await promisify(execFile)(process.execPath, ['cli/main.ts', 'status'], {
      env: cliEnv,
    });
    assert.deepEqual(JSON.parse(status.stdout).projects, []);
    const connected = JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            'cli/main.ts',
            'projects.connect',
            JSON.stringify({
              root: directory,
              name: 'Example project',
            }),
          ],
          {
            env: cliEnv,
          },
        )
      ).stdout,
    );
    assert.equal(connected.ok, true);
    browser = await chromium.launch({
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const token = await apiCredential({
      directory,
    });
    await page.goto(address.ui + '#buro-token=' + token);
    await expect(
      page.locator('.sidebar').getByText('Service connected', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('h1')).toContainText('Example project');
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('.sidebar').getByRole('button', {
      name: 'Models',
      exact: true,
    }).click();
    await expect(
      page.getByText('Add a model connection to start a run.', {
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
    child.kill('SIGTERM');
    await exited;
    const reopened = await createApplication({
      directory,
    });
    assert.equal((await reopened.projects.list())[0].name, 'Example project');
    await reopened.close();
  },
);
