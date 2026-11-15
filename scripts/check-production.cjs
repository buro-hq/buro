const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage({ viewport: { width: 1512, height: 1080 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    fs.mkdirSync('artifacts', { recursive: true });
    const requests = [];
    p.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await p.goto('http://127.0.0.1:4327/?source=replay');
    await p.locator('.empty-office-canvas').waitFor();
    assert.equal(await p.locator('.desk').count(), 0);
    assert.equal(await p.locator('.source-select input').inputValue(), 'Offline drafts');
    await p.screenshot({ path: 'artifacts/office-desktop.png' });
    await p.setViewportSize({ width: 390, height: 980 });
    await p.screenshot({ path: 'artifacts/office-mobile.png' });
    assert.ok(!requests.includes('/records.json'));
    assert.ok(!requests.some((pathname) => pathname.startsWith('/artifacts/')));
    assert.deepEqual(errors, []);
    const result = {
      production: true,
      emptyHistory: true,
      noRecordingRequests: true,
      desktopAndMobile: true,
      errors,
    };
    fs.writeFileSync('artifacts/production-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
