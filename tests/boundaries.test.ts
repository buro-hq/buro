import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
async function sources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? sources(path.join(dir, e.name))
          : /\.(ts|tsx)$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
      ),
    )
  ).flat();
}
function imports(source: string) {
  return [...source.matchAll(/(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
}
test('neutral agent contracts depend only on other neutral contracts', async () => {
  const root = path.resolve('agent/contracts');
  for (const file of await sources(root))
    for (const name of imports(await fs.readFile(file, 'utf8'))) {
      assert.ok(name.startsWith('.'), `${file}: external dependency ${name}`);
      const target = path.resolve(path.dirname(file), name);
      assert.ok(target.startsWith(root + path.sep), `${file}: application dependency ${name}`);
    }
});
test('domain and protocol have no framework/platform imports; clients never import backend', async () => {
  for (const dir of ['core', 'protocol'])
    for (const file of await sources(dir))
      for (const name of imports(await fs.readFile(file, 'utf8'))) {
        assert.ok(!/^(node:|react|@mantine|cordis$|ws$)/.test(name), `${file}: ${name}`);
        assert.ok(!/(?:^|\/)(?:plugins|adapters|daemon|src)\//.test(name), `${file}: ${name}`);
      }
  for (const dir of ['src', 'clients'])
    for (const file of await sources(dir))
      for (const name of imports(await fs.readFile(file, 'utf8'))) {
        if (!name.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), name);
        for (const backend of ['core', 'plugins', 'adapters', 'daemon'])
          assert.ok(!target.startsWith(path.resolve(backend) + path.sep), `${file}: ${name}`);
      }
});
