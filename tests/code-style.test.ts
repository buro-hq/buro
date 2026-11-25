import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { getFileInfo } from 'prettier';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const formatter = new ESLint({
  overrideConfigFile: 'tooling/eslint-style.mjs',
  fix: true,
});

const renderTsx = (source: string): string => {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const scope = {
    exports: {} as { View?: () => ReactNode },
    require: createRequire(import.meta.url),
  };
  vm.runInNewContext(compiled, scope);

  return renderToStaticMarkup(createElement(scope.exports.View!));
};

const format = async (input: { code: string; filePath?: string }): Promise<string> => {
  const [result] = await formatter.lintText(input.code, {
    filePath: input.filePath ?? 'src/style-example.ts',
  });
  assert.deepEqual(result.messages, [], 'Formatting must converge without remaining diagnostics');

  return result.output ?? input.code;
};

// Source positions and spelling of quotes are irrelevant; syntax and literal values are not.
const syntax = (code: string): unknown => {
  const source = ts.createSourceFile('example.ts', code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): unknown => {
    const children: unknown[] = [];
    node.forEachChild((child) => {
      children.push(visit(child));
    });
    const text = ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ? node.text
      : undefined;

    return { kind: node.kind, text, children };
  };

  return visit(source);
};

test('formatting honors the selected guards, argument objects and short values', async () => {
  const code = `const run = async (): Promise<unknown> => {
  if (!ready) return;
  if (stopped) return;
  await sessions.run({ sessionId, input, workspace });
  return { ok: true, sessionId };
};
const statuses = ['idle', 'running'];
const names = runs.filter(isCompleted).map(toName);
const range = items.slice(start, end);
`;
  const output = await format({
    code,
  });
  assert.equal(output, `const run = async (): Promise<unknown> => {
  if (!ready)
    return;

  if (stopped)
    return;

  await sessions.run({
    sessionId,
    input,
    workspace,
  });
  return { ok: true, sessionId };
};
const statuses = ['idle', 'running'];
const names = runs.filter(isCompleted).map(toName);
const range = items.slice(start, end);
`);
  assert.deepEqual(syntax(output), syntax(code));
  assert.equal(await format({
    code: output,
  }), output);
});

test('object expansion preserves comments, nested values, spread and constructor arguments', async () => {
  const code = `const result = call({ /* opening */ first: 1, /* middle */ ...rest, nested: { ok: true } /* closing */ });
const second = new Store({ root, token: 'a b' });
const third = api?.read?.({ id, options: { limit: 5 } });
const empty = call({});
const typed = call({ id, root } satisfies Options);
const asserted = call(({ id, root } as Options)!);
const comment = call({ first: 1, // keep with first
  second: 2 });
const text = call({ value: \`first
  second\`, pattern: /a b/ });
`;
  const output = await format({
    code,
  });
  assert.deepEqual(syntax(output), syntax(code));
  for (const comment of ['/* opening */', '/* middle */', '/* closing */', '// keep with first'])
    assert.ok(output.includes(comment));

  assert.ok(output.includes('nested: { ok: true }'));
  assert.ok(output.includes('call({})'));
  assert.match(output, /const typed = call\(\{\n/);
  assert.match(output, /const asserted = call\(\(\{\n/);
  assert.equal(await format({
    code: output,
  }), output);
});

test('formatting preserves logical groups and puts continued operators at the end of the line', async () => {
  const code = `const { id, modelId } = run;
const model = models.get(modelId);

const canPublish = isCompleted
  && hasChanges
  && canWrite;

await publish({ id, model });
`;
  const output = await format({
    code,
  });
  assert.match(output, /models.get\(modelId\);\n\nconst canPublish/);
  assert.match(output, /isCompleted &&\n/);
  assert.match(output, /hasChanges &&\n/);
  assert.deepEqual(syntax(output), syntax(code));
  assert.equal(await format({
    code: output,
  }), output);
});

test('separate variable declarations and inline type modifiers are automatically fixed', async () => {
  const code = `import { createSession, Session } from './session';
const first = 1, second = 2;
const session: Session = createSession();
`;
  const output = await format({
    code,
  });
  assert.match(output, /import \{ createSession, type Session \} from/);
  assert.match(output, /const first = 1;\nconst second = 2;/);
  assert.equal(await format({
    code: output,
  }), output);
});

test('formatting TSX preserves rendered text and is stable on the second pass', async () => {
  const code = `const name = 'Ada';
export const View = () => <div><span>Hello</span> {name}<span>!</span></div>;
`;
  const output = await format({
    code,
    filePath: 'src/style-example.tsx',
  });
  assert.equal(renderTsx(output), renderTsx(code));
  assert.equal(await format({
    code: output,
    filePath: 'src/style-example.tsx',
  }), output);
});

test('inline JSX separators retain spaces on both sides of expressions', async () => {
  const code = `const status = 'A';
const path = 'result.txt';
export const View = () => <section><p>{status} · {path}</p><p>{status} / {path}</p><p>{status} {path}</p></section>;
`;
  const output = await format({
    code,
    filePath: 'src/style-example.tsx',
  });
  const rendered = renderTsx(output);
  assert.equal(rendered, renderTsx(code));
  assert.ok(rendered.includes('A · result.txt'));
  assert.ok(rendered.includes('A / result.txt'));
  assert.equal(await format({
    code: output,
    filePath: 'src/style-example.tsx',
  }), output);
});

test('documented union members keep their comments and leading type separators', async () => {
  const code = `type Event =
  | { type: 'text'; text: string }
  /** A terminal observation. */
  | { type: 'done'; status: string };
`;
  const output = await format({
    code,
  });
  assert.deepEqual(syntax(output), syntax(code));
  assert.match(output, /\/\*\* A terminal observation\. \*\/\n {2}\|/);
  assert.equal(await format({
    code: output,
  }), output);
});

test('formatting and correctness have distinct configurations', async (t) => {
  const code = 'Promise.resolve(1);\n';
  assert.equal(await format({
    code,
  }), code);
  // CI's single-run TypeScript program reads disk; exercise actual files in an isolated project.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-style-project-'));
  t.after(() => fs.rm(directory, {
    recursive: true,
    force: true,
  }));
  await fs.mkdir(path.join(directory, 'src'));
  const project = path.join(directory, 'tsconfig.json');
  await fs.writeFile(project, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, types: [] },
    include: ['src'],
  }));
  await fs.writeFile(path.join(directory, 'src/unsafe.ts'), code);
  await fs.writeFile(path.join(directory, 'src/safe.ts'), 'void Promise.resolve(1);\n');
  const linter = new ESLint({
    cwd: directory,
    overrideConfigFile: path.resolve('eslint.config.mjs'),
    overrideConfig: [{
      files: ['src/**/*.ts'],
      languageOptions: { parserOptions: { project: [project], tsconfigRootDir: directory } },
    }],
  });
  const results = await linter.lintFiles(['src/*.ts']);
  const unsafe = results.find((result) => path.basename(result.filePath) === 'unsafe.ts')!;
  const safe = results.find((result) => path.basename(result.filePath) === 'safe.ts')!;
  assert.ok(unsafe.messages.some(({ ruleId }) => ruleId === '@typescript-eslint/no-floating-promises'), JSON.stringify(unsafe.messages));
  assert.deepEqual(safe.messages, []);
});

test('format owners agree on source and exclude generated and private state', async () => {
  for (const file of ['src/data/application.tsx', 'modules/api/client.ts', 'tooling/eslint-style.mjs']) {
    const info = await getFileInfo(file, {
      ignorePath: '.prettierignore',
    });
    assert.equal(info.ignored, true, file);
    assert.equal(await formatter.isPathIgnored(file), false, file);
  }

  for (const file of ['.buro/private/state.json', '.codex/settings.json', '.проект/state.ts', '.firecrawl/result.ts', 'artifacts/check.ts', 'docs/archive/old.ts']) {
    assert.equal(await formatter.isPathIgnored(file), true, file);
    assert.equal((await getFileInfo(file, {
      ignorePath: '.prettierignore',
    })).ignored, true, file);
  }

  assert.equal((await getFileInfo('src/styles/features.css', {
    ignorePath: '.prettierignore',
  })).ignored, false);
});
