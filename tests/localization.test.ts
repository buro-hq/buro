import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ru from '../src/i18n/locales/ru.json' with { type: 'json' };
import { getLocale, setLocale, t } from '../src/i18n/index.ts';
const parameters = (text: string) => [...text.matchAll(/\{p\d+\}/g)].map((m) => m[0]).sort();
test('English and Russian catalogs have matching keys, parameters and complete static UI coverage', async () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(en[key].length > 0);
    assert.ok(ru[key].length > 0);
    assert.deepEqual(parameters(ru[key]), parameters(en[key]), key);
    assert.equal(/[\u0400-\u04ff]/.test(key), false, key);
  }
  for (const name of await fs.readdir('src', { recursive: true })) {
    const file = path.join('src', name);
    if (!/\.tsx?$/.test(file) || file.startsWith('src/i18n')) continue;
    const source = await fs.readFile(file, 'utf8');
    assert.equal(/[\u0400-\u04ff]/.test(source), false, file);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        assert.ok(Object.hasOwn(en, node.arguments[0].text), file + ': ' + node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});
test('locale changes translate product messages and parameters while preserving unknown user content', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(t('Cancel'), 'Cancel');
  setLocale('ru');
  assert.equal(t('Cancel'), ru.Cancel);
  assert.equal(t('Theme {p0}', { p0: 'Iris' }), ru['Theme {p0}'].replace('{p0}', 'Iris'));
  assert.equal(t('Unknown user-authored title'), 'Unknown user-authored title');
  setLocale('en');
  assert.equal(t('Cancel'), 'Cancel');
});

test('built-in role labels translate without rewriting custom role text', async () => {
  const { roleLabels } = await import('../src/ui/role-labels.ts');
  setLocale('ru');
  assert.equal(
    roleLabels({ id: 'implementer', title: 'Developer', description: 'Implements agreed changes.' })
      .title,
    ru.Developer,
  );
  setLocale('en');
  assert.equal(
    roleLabels({
      id: 'implementer',
      title: ru.Developer,
      description: ru['Implements agreed changes.'],
    }).title,
    'Developer',
  );
  assert.equal(
    roleLabels({ id: 'implementer', title: 'My custom role', description: 'Custom content' }).title,
    'My custom role',
  );
});
