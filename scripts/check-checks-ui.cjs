const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('playwright');

async function main() {
  const built = await build({
    stdin: {
      contents: `
      import { createElement } from 'react';
      import { MantineProvider } from '@mantine/core';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ChecksPanel } from './src/components/organisms/ChecksPanel.tsx';
      import { ResultPanel } from './src/components/organisms/ResultPanel.tsx';
      import { RunRail } from './src/components/organisms/RunRail.tsx';
      import { ProjectProvider } from './src/data/provider.tsx';
      import { setLocale } from './src/i18n/index.ts';
      export function render(run, cursor, locale) {
        setLocale(locale);
        return renderToStaticMarkup(createElement(MantineProvider, {forceColorScheme:'light'}, createElement(ProjectProvider, null, createElement('main', null,
          createElement('section', {id:'checks'}, createElement(ChecksPanel, {run,cursor,onInspect(){}})),
          createElement('section', {id:'result'}, createElement(ResultPanel, {run,cursor})),
          createElement(RunRail, {run,cursor,roles:{},onAgent(){}})))));
      }
    `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external',
    jsx: 'automatic',
  });
  const compiled = { exports: {} };
  globalThis.location = { search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(
    require,
    compiled,
    compiled.exports,
  );
  const at = (value) => new Date(Date.UTC(2026, 10, 20, 12, 0, value)).toISOString();
  const base = {
    id: 'R-1',
    key: 'R-1',
    agents: [],
    plan: [],
    threadId: 'T',
    goalId: 'G-1',
    createdAt: at(0),
    completedAt: at(10),
    status: 'failed',
    phase: 'done',
    events: [],
    commands: [],
    acceptance: { passed: 0, total: 0, results: [] },
    independentReviewer: false,
    scopePreserved: true,
    specsUnchanged: true,
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    for (const locale of ['en', 'ru']) {
      const html = compiled.exports.render(base, 10, locale);
      await page.setContent(html);
      assert.equal(await page.locator('.check-list .green-text').count(), 0);
      assert.equal(await page.locator('.section-heading .green-text').count(), 0);
      assert.equal(await page.locator('.right-rail .metric-row .green-text').count(), 0);
      assert.doesNotMatch(
        await page.locator('#result').innerText(),
        locale === 'en'
          ? /Implementation ready|Implementation, tests and independent review are complete\./
          : /Реализация готова/,
      );
      assert.doesNotMatch(
        await page.locator('.check-summary').innerText(),
        locale === 'en' ? /Some checks failed/ : /Есть непройденные проверки/,
      );
    }
    const observed = {
      ...base,
      independentReviewer: true,
      events: [
        { at: at(5), type: 'checks.completed' },
        { at: at(9), type: 'review.completed' },
      ],
      acceptance: {
        passed: 1,
        total: 1,
        results: [
          {
            name: 'Protected test',
            passed: true,
            command: 'npm test',
            exitCode: null,
            output: 'FUTURE_PRIVATE_OUTPUT',
          },
        ],
      },
      commands: [
        {
          id: 'c',
          threadId: 't',
          command: 'npm test',
          startedAt: at(1),
          completedAt: at(8),
          exitCode: null,
          output: '# tests 2\\n# pass 2',
        },
      ],
    };
    await page.setContent(compiled.exports.render(observed, 4, 'en'));
    assert.doesNotMatch(
      await page.locator('body').innerText(),
      /FUTURE_PRIVATE_OUTPUT|Protected test|PASS|Review approved/,
    );
    assert.equal(await page.locator('details').count(), 0);
    await page.setContent(compiled.exports.render(observed, 10, 'en'));
    assert.match(await page.locator('.check-summary').innerText(), /Evidence unavailable/);
    assert.doesNotMatch(await page.locator('.check-list').innerText(), /PASS/);
    assert.equal(await page.locator('.section-heading .green-text').count(), 0);
    assert.equal(await page.locator('.right-rail .metric-row .green-text').count(), 0);
    assert.doesNotMatch(
      await page.locator('#result').innerText(),
      /Independent review completed\.|Implementation ready/,
    );
    const verified = {
      ...base,
      status: 'completed',
      commit: 'abc123',
      acceptance: {
        passed: 1,
        total: 1,
        results: [{ name: 'Protected', command: 'npm test', exitCode: 0, passed: true }],
      },
      independentReviewer: true,
      review: { verdict: 'approved', blockingFindings: [], summary: 'Reviewed' },
    };
    await page.setContent(compiled.exports.render({ ...verified, status: undefined }, 10, 'en'));
    assert.match(await page.locator('#result h2').innerText(), /Result recorded/);
    assert.doesNotMatch(await page.locator('#result').innerText(), /Implementation ready/);
    await page.setContent(compiled.exports.render(verified, 10, 'en'));
    assert.equal(await page.locator('#result h2').innerText(), 'Implementation ready');
    await page.setContent(
      compiled.exports.render(
        {
          ...verified,
          review: { ...verified.review, blockingFindings: ['Blocking behavior defect'] },
        },
        10,
        'en',
      ),
    );
    assert.match(await page.locator('#result .result-receipt').innerText(), /Changes requested/);
    assert.doesNotMatch(
      await page.locator('#result').innerText(),
      /Review approved|Implementation ready/,
    );
    await fs.mkdir('artifacts', { recursive: true });
    const result = {
      passed: true,
      locales: ['en', 'ru'],
      zeroChecksNotFailed: true,
      nullExitNotPassed: true,
      futureOutputHidden: true,
      reviewFlagNotApproval: true,
      surfaces: ['ChecksPanel', 'RunRail', 'ResultPanel'],
      legacyResultNotAcceptance: true,
      readyRequiresEvidenceAndCommit: true,
      contradictoryReviewNotApproved: true,
    };
    await fs.writeFile(
      'artifacts/checks-ui-verification.json',
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
