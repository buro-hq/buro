const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  const browser = await chromium.launch();
  try {
    await fs.mkdir('artifacts', { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1512, height: 1080 } });
    const page = await context.newPage(),
      errors = [],
      observed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:4317/?source=replay');
    await page.locator('.office-canvas').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-mantine-color-scheme'), 'light');
    await page.getByRole('button', { name: 'Open user settings', exact: true }).click();
    await page.getByRole('heading', { name: 'User settings', exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Theme Cobalt', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    await page.evaluate(() =>
      localStorage.setItem('project-panel-theme', JSON.stringify('unknown')),
    );
    await page.reload();
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: 'Theme Cobalt', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(await page.locator('.theme-preview').count(), 5);
    assert.equal(
      await page.getByRole('textbox', { name: 'Time policy · TODO', exact: true }).isDisabled(),
      true,
    );
    const rgb = (value) =>
      value
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((n) => Number(n) * (value.startsWith('color(srgb') ? 255 : 1));
    const lum = (color) =>
      rgb(color)
        .map((c) => {
          c /= 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
    for (const scheme of ['Dark', 'Light']) {
      await page.getByRole('button', { name: scheme, exact: true }).click();
      for (const name of ['Sage', 'Graphite', 'Ocean', 'Iris', 'Cobalt']) {
        const button = page.getByRole('button', { name: 'Theme ' + name, exact: true });
        await button.click();
        await page.waitForFunction(
          () =>
            !document.querySelector('.theme-option.selected')?.textContent.includes('undefined'),
        );
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        const colors = await page.locator('.content-panel').evaluate((el) => {
          const style = getComputedStyle(el),
            body = getComputedStyle(document.body);
          return {
            background: style.backgroundColor,
            text: style.color,
            body: body.backgroundColor,
            accent: style.getPropertyValue('--accent').trim(),
          };
        });
        const a = lum(colors.background),
          b = lum(colors.text),
          contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        assert.ok(contrast >= 4.5, JSON.stringify({ scheme, name, colors, contrast }));
        await page
          .locator('.hero-actions')
          .getByRole('button', { name: 'New goal', exact: true })
          .click();
        await page
          .getByRole('textbox', { name: 'What should we achieve?', exact: true })
          .fill('Contrast check');
        await page
          .getByRole('textbox', { name: 'Context and expected result', exact: true })
          .fill('Check active primary button contrast');
        const submit = page.getByRole('button', { name: 'Save goal', exact: true });
        assert.equal(await submit.isDisabled(), false);
        const primaryColors = await submit.evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          text: getComputedStyle(el).color,
        }));
        const foregroundLum = lum(primaryColors.text),
          backgroundLum = lum(primaryColors.background);
        const primaryContrast =
          (Math.max(foregroundLum, backgroundLum) + 0.05) /
          (Math.min(foregroundLum, backgroundLum) + 0.05);
        assert.ok(
          primaryContrast >= 4.5,
          JSON.stringify({ scheme, name, primaryColors, primaryContrast }),
        );
        await page.locator('.mantine-Modal-close').click();
        observed.push({ scheme, name, ...colors, contrast });
      }
    }
    assert.equal(new Set(observed.map((c) => c.accent)).size, 10);
    await page.screenshot({ path: 'artifacts/themes-light.png' });
    await page.getByRole('button', { name: 'Theme Iris', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'User settings', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: 'Theme Iris', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    for (const width of [1512, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 980 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
        'overflow at ' + width,
      );
    }
    await page.screenshot({ path: 'artifacts/themes-mobile.png' });
    await page.setViewportSize({ width: 1512, height: 1080 });
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(
      () => document.documentElement.dataset.mantineColorScheme === 'light',
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(
      () => document.documentElement.dataset.mantineColorScheme === 'dark',
    );
    await page.getByRole('button', { name: 'Theme Cobalt', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.screenshot({ path: 'artifacts/themes-dark.png' });
    await page.locator('.sidebar').getByRole('button', { name: 'Office', exact: true }).click();
    await page.screenshot({ path: 'artifacts/themed-office-dark.png' });
    await page.getByRole('button', { name: 'Open user settings', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.locator('.sidebar').getByRole('button', { name: 'Office', exact: true }).click();
    const primary = await page.locator('.hero-actions .mantine-Button-root').evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    }));
    assert.ok(
      (Math.max(lum(primary.bg), lum(primary.color)) + 0.05) /
        (Math.min(lum(primary.bg), lum(primary.color)) + 0.05) >=
        4.5,
      JSON.stringify(primary),
    );
    await page.screenshot({ path: 'artifacts/themed-office-light.png' });
    await page
      .locator('.hero-actions')
      .getByRole('button', { name: 'New goal', exact: true })
      .click();
    const modal = await page.locator('.mantine-Modal-content').evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    }));
    assert.ok(lum(modal.bg) > 0.5, JSON.stringify(modal));
    assert.deepEqual(errors, []);
    const result = {
      passed: [
        'Cobalt light is the default; unknown palettes fall back to Cobalt',
        'avatar opens appearance settings',
        'five palette previews',
        'ten palette/scheme combinations have readable panel text',
        'choice survives reload',
        'settings fit 320px–1512px',
        'auto scheme follows the system',
        'shared office and Mantine modal use chosen appearance',
      ],
      observed,
      errors,
    };
    await fs.writeFile('artifacts/appearance-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
