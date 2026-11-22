import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileProjectStore } from '../adapters/files/project-store.ts';
import { ProjectStoreRegistry } from '../core/project-registry.ts';
import { LocalBrowser } from '../adapters/files/local-browser.ts';
import { ContextMaterials, stageContextMaterials } from '../adapters/files/context-materials.ts';
import { GoalService } from '../core/services.ts';
import { goalMaterials } from '../core/context.ts';
import { parseSnapshot } from '../protocol/schema.ts';

async function fixture(t: any) {
  const directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'context-materials-')),
    ),
    root = path.join(directory, 'repo');
  await fs.mkdir(root);
  const options = {
      directory: path.join(root, '.buro'),
      project: { id: 'p', name: 'Project', root },
    },
    store = await FileProjectStore.open(options),
    projects = new ProjectStoreRegistry([store]);
  const materials = new ContextMaterials(projects),
    browser = new LocalBrowser(projects),
    goals = new GoalService({
      projects,
      now: () => new Date().toISOString(),
      id: () => crypto.randomUUID(),
    });
  t.after(async () => {
    await materials.dispose();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, store, projects, materials, browser, goals, options };
}
test('folder browser supports hidden files and search, and confines project paths including symlinks', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'src'));
  await fs.writeFile(path.join(f.root, '.hidden'), 'hidden');
  await fs.writeFile(path.join(f.root, 'notes.md'), 'notes');
  await fs.symlink(f.directory, path.join(f.root, 'outside'), 'dir');
  const listing = await f.browser.list({ projectId: 'p', restricted: true });
  assert.equal(listing.path, f.root);
  assert.equal(listing.parent, f.root);
  assert.equal(
    listing.entries.some((e) => e.name === '.hidden'),
    false,
  );
  assert.equal(listing.entries.find((e) => e.name === 'outside')!.selectable, false);
  assert.deepEqual(
    (await f.browser.list({ projectId: 'p', showHidden: true, query: '.hidden' })).entries.map(
      (e) => e.name,
    ),
    ['.hidden'],
  );
  await assert.rejects(f.browser.list({ projectId: 'p', restricted: true, path: f.directory }), {
    code: 'OUTSIDE_PROJECT',
  });
  await assert.rejects(
    f.browser.list({ projectId: 'p', restricted: true, path: path.join(f.root, 'outside') }),
    { code: 'OUTSIDE_PROJECT' },
  );
  await assert.rejects(f.browser.list({ path: path.join(f.root, 'missing') }), {
    code: 'DIRECTORY_UNAVAILABLE',
  });
});
test('imports are immutable, deduplicated, private and durable; request retry never rereads changed source', async (t) => {
  const f = await fixture(t),
    source = path.join(f.directory, 'requirements.md');
  await fs.writeFile(source, 'Original requirements');
  const input = { projectId: 'p', scope: 'project' as const, paths: [source] },
    first = await f.materials.import('first', 'first', input);
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'requirements.md');
  assert.equal(first[0].mimeType, 'text/markdown');
  assert.equal(await fs.readFile(source, 'utf8'), 'Original requirements');
  assert.equal((await f.materials.import('same-file', 'same-file', input))[0].id, first[0].id);
  assert.equal(f.store.snapshot().contextMaterials?.length, 1);
  await fs.writeFile(source, 'New requirements');
  assert.deepEqual(await f.materials.import('first', 'first', input), first);
  const workspace = path.join(f.directory, 'workspace');
  await fs.mkdir(workspace);
  await stageContextMaterials(f.root, workspace, first);
  const staged = path.join(workspace, '.buro/context', path.basename(first[0].relativePath));
  assert.equal(await fs.readFile(staged, 'utf8'), 'Original requirements');
  const newVersion = await f.materials.import('changed', 'changed', input);
  assert.notEqual(newVersion[0].hash, first[0].hash);
  assert.equal(await fs.readFile(staged, 'utf8'), 'Original requirements');
  parseSnapshot(f.store.snapshot());
  const privateFile = await fs.readFile(path.join(f.root, '.buro/control-state.json'), 'utf8');
  assert.ok(!privateFile.includes('Original requirements'));
  assert.ok(!privateFile.includes(Buffer.from('Original requirements').toString('base64')));
  await fs.chmod(staged, 0o600);
  await fs.writeFile(staged, 'Changed staged input');
  await assert.rejects(
    stageContextMaterials(f.root, workspace, first),
    /material snapshot changed/,
  );
  await f.store.close();
  const reopened = await FileProjectStore.open(f.options);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().contextMaterials?.length, 2);
});
test('project and goal scopes are selected independently; removing a project material preserves historical snapshots', async (t) => {
  const f = await fixture(t);
  const upload = (name: string, text: string, scope: 'project' | 'goal') =>
    f.materials.import(name, name, {
      projectId: 'p',
      scope,
      upload: { name, base64: Buffer.from(text).toString('base64') },
    });
  const [shared] = await upload('shared.txt', 'Shared context', 'project'),
    [specific] = await upload('specific.txt', 'Only this goal', 'goal');
  const goal = await f.goals.create('g', 'g', {
    projectId: 'p',
    title: 'Goal',
    body: 'Implement',
    criteria: '',
    materialIds: [specific.id],
  });
  const frozen = goalMaterials(f.store.doc, goal);
  assert.deepEqual(
    frozen.map((m) => m.id),
    [shared.id, specific.id],
  );
  const other = await f.goals.create('g2', 'g2', {
    projectId: 'p',
    title: 'Other',
    body: 'Implement',
    criteria: '',
  });
  assert.deepEqual(
    goalMaterials(f.store.doc, other).map((m) => m.id),
    [shared.id],
  );
  await f.materials.remove('remove', 'remove', { projectId: 'p', materialId: shared.id });
  assert.deepEqual(
    goalMaterials(f.store.doc, goal).map((m) => m.id),
    [specific.id],
  );
  assert.equal(frozen[0].active, true);
  await assert.rejects(
    f.goals.create('bad', 'bad', {
      projectId: 'p',
      title: 'Bad',
      body: 'Bad',
      criteria: '',
      materialIds: ['M-other'],
    }),
    { code: 'CONTEXT_NOT_FOUND' },
  );
});
test('folder import skips secrets, dependencies and symlinks and rejects invalid or oversized uploads', async (t) => {
  const f = await fixture(t),
    folder = path.join(f.directory, 'materials');
  await fs.mkdir(path.join(folder, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(folder, 'readme.md'), 'Useful');
  await fs.writeFile(path.join(folder, 'font.woff'), Buffer.from([0, 255, 42]));
  await fs.writeFile(path.join(folder, '.env'), 'secret');
  await fs.writeFile(path.join(folder, 'node_modules/large.js'), 'Dependency');
  await fs.symlink(path.join(folder, 'readme.md'), path.join(folder, 'alias.md'));
  const result = await f.materials.import('folder', 'folder', {
    projectId: 'p',
    scope: 'goal',
    paths: [folder],
  });
  assert.deepEqual(
    result.map((m) => m.name),
    ['materials/readme.md'],
  );
  await assert.rejects(
    f.materials.import('env', 'env', {
      projectId: 'p',
      scope: 'goal',
      paths: [path.join(folder, '.env')],
    }),
    { code: 'UNSUPPORTED_CONTEXT' },
  );
  await assert.rejects(
    f.materials.import('binary', 'binary', {
      projectId: 'p',
      scope: 'goal',
      upload: { name: 'unknown.bin', base64: Buffer.from([0, 255, 1]).toString('base64') },
    }),
    { code: 'UNSUPPORTED_CONTEXT' },
  );
  await assert.rejects(
    f.materials.import('large', 'large', {
      projectId: 'p',
      scope: 'goal',
      upload: { name: 'large.txt', base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
    }),
    { code: 'CONTEXT_LIMIT' },
  );
});
test('staging refuses a symlinked context directory without writing outside the workspace', async (t) => {
  const f = await fixture(t),
    [material] = await f.materials.import('file', 'file', {
      projectId: 'p',
      scope: 'goal',
      upload: { name: 'doc.md', base64: Buffer.from('Document').toString('base64') },
    }),
    workspace = path.join(f.directory, 'workspace'),
    outside = path.join(f.directory, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, '.buro'), 'dir');
  await assert.rejects(
    stageContextMaterials(f.root, workspace, [material]),
    /Invalid context directory/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test(
  'macOS PDF and DOCX attachments expose extracted text while retaining the original bytes',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t),
      { execFile } = await import('node:child_process'),
      { promisify } = await import('node:util');
    await promisify(execFile)('python3', [
      '-c',
      `import sys, pathlib, zipfile
root=pathlib.Path(sys.argv[1])
stream=b'BT /F1 18 Tf 30 100 Td (PDF requirement) Tj ET'
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\\nstream\\n'+stream+b'\\nendstream']
data=b'%PDF-1.4\\n'; offsets=[0]
for i,obj in enumerate(objects,1):
 offsets.append(len(data)); data+=str(i).encode()+b' 0 obj\\n'+obj+b'\\nendobj\\n'
xref=len(data); data+=b'xref\\n0 6\\n0000000000 65535 f \\n'+b''.join(('%010d 00000 n \\n'%n).encode() for n in offsets[1:])+b'trailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n'+str(xref).encode()+b'\\n%%EOF'
(root/'requirements.pdf').write_bytes(data)
with zipfile.ZipFile(root/'requirements.docx','w') as z:
 z.writestr('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX requirement</w:t></w:r></w:p></w:body></w:document>')
`,
      f.directory,
    ]);
    const materials = await f.materials.import('documents', 'documents', {
      projectId: 'p',
      scope: 'project',
      paths: [
        path.join(f.directory, 'requirements.pdf'),
        path.join(f.directory, 'requirements.docx'),
      ],
    });
    for (const [i, material] of materials.entries()) {
      assert.ok(material.textPath, material.note);
      assert.match(
        await fs.readFile(path.join(f.root, '.buro', material.textPath), 'utf8'),
        new RegExp(i === 0 ? 'PDF requirement' : 'DOCX requirement'),
      );
      assert.deepEqual(
        await fs.readFile(path.join(f.root, '.buro', material.relativePath)),
        await fs.readFile(path.join(f.directory, material.name)),
      );
    }
  },
);
