const { chromium } = require('@playwright/test');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1512, height: 1080 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.goto('http://127.0.0.1:4317');
  await p.locator('.office-canvas').waitFor();
  await p.screenshot({ path: 'artifacts/office-desktop.png', fullPage: true });
  console.log(await p.locator('.office-canvas').boundingBox());
  console.log(
    'overflow',
    await p.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth })),
  );
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
