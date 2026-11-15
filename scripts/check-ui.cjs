const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  fs.mkdirSync('artifacts', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const go = async (label) =>
    page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
  await page.goto('http://127.0.0.1:4317/?source=replay');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('.empty-office-canvas').waitFor();
  assert.equal(await page.locator('.desk').count(), 0);
  assert.equal(await page.locator('.player').count(), 0);
  assert.equal(await page.locator('.source-select input').inputValue(), 'Offline drafts');
  await page.screenshot({ path: 'artifacts/office-desktop.png' });
  await go('Runs');
  await page.getByRole('heading', { name: 'No runs yet', exact: true }).waitFor();
  await go('.buro files');
  assert.equal(await page.locator('.artifact-list a').count(), 0);
  await page
    .locator('.hero-actions')
    .getByRole('button', { name: 'New goal', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'What should we achieve?' }).fill('Office search');
  await page
    .getByRole('textbox', { name: 'Context and expected result' })
    .fill('Find agents and their tasks by name.');
  await page
    .getByRole('textbox', { name: 'How will we know it is done?' })
    .fill('The filter preserves the selected project.');
  assert.equal(
    await page.getByRole('checkbox', { name: 'Allow environment repair', exact: true }).isChecked(),
    false,
  );
  await page.getByRole('checkbox', { name: 'Allow environment repair', exact: true }).check();
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  assert.ok((await page.locator('.draft-card').innerText()).includes('Office search'));
  await page.reload();
  await go('Goals');
  assert.ok((await page.locator('.draft-card').innerText()).includes('Office search'));
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(
    await page.getByRole('checkbox', { name: 'Allow environment repair', exact: true }).isChecked(),
    true,
  );
  await page.getByRole('checkbox', { name: 'Allow environment repair', exact: true }).uncheck();
  await page
    .getByRole('textbox', { name: 'Context and expected result' })
    .fill('Revised search context.');
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await page.locator('.mantine-Modal-content').waitFor({ state: 'hidden' });
  await page.reload();
  await go('Goals');
  assert.ok((await page.locator('.draft-card').innerText()).includes('Revised search context.'));
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('project-panel-drafts-v1'))[0].revision,
    ),
    2,
  );
  await page.getByRole('button', { name: 'Delete draft Office search' }).click();
  assert.equal(await page.locator('.draft-card').count(), 0);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.locator('.projects-modal').waitFor();
  assert.equal(await page.locator('.connected-project').count(), 1);
  assert.ok((await page.locator('.projects-modal').innerText()).includes('local service'));
  await page.locator('.connected-project').click();
  await go('Office');
  const overflow = [];
  for (const width of [1512, 1280, 1024, 768, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 980 });
    const d = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    overflow.push({ width, ...d });
  }
  assert.ok(
    overflow.every((x) => x.scroll <= x.client + 1),
    JSON.stringify(overflow),
  );
  await page.setViewportSize({ width: 390, height: 980 });
  await page.screenshot({ path: 'artifacts/office-mobile.png' });
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.locator('.mobile-sidebar').getByRole('button', { name: 'Goals', exact: true }).click();
  await page.getByRole('heading', { name: 'Project goals', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const receipt = {
    passed: [
      'offline mode starts without captured runs or artifact downloads',
      'draft creation, versioned edit, persistence and delete',
      'project entry',
      'responsive empty office and mobile navigation',
    ],
    errors,
    overflow,
  };
  fs.writeFileSync('artifacts/ui-verification.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
