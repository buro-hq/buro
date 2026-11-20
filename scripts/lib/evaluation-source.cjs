const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forbidden =
  /^(?:\.git|\.buro|\.codex|\.aws|\.ssh|node_modules|\.env(?:\..*)?|.*\.env|\.npmrc|\.netrc|\.git-credentials|credentials|private)$/i;
function relativeFile(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\\'))
    throw Error('Evaluation sources require exact relative file paths.');
  const parts = file.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || forbidden.test(part)) ||
    /\.(?:pem|key|p12|pfx|keystore)$/i.test(file)
  )
    throw Error('An evaluation source path is private or unsafe.');
  return parts;
}
async function sourceBytes(root, file) {
  const parts = relativeFile(file);
  if ((await fs.lstat(root)).isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw Error('Evaluation source root changed.');
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw Error('Evaluation source must not contain symlinks or special files.');
  }
  const before = await fs.lstat(target);
  if (before.size > 2 * 1024 * 1024) throw Error('Evaluation source file exceeds the size limit.');
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      (await fs.realpath(target)) !== target
    )
      throw Error('Evaluation source changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length > 2 * 1024 * 1024)
      throw Error('Evaluation source file exceeds the size limit.');
    return bytes;
  } finally {
    await handle.close();
  }
}
async function repositoryState(root) {
  const { safeGit } = await import('../../adapters/processes/safe-git.ts');
  const head = (await safeGit(['rev-parse', '--verify', 'HEAD'], { cwd: root })).stdout.trim();
  const status = (
    await safeGit(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root })
  ).stdout;
  return { head, statusHash: hash(status), clean: !status };
}
async function captureSource(definition) {
  const root = path.resolve(definition.sourceRoot);
  const files = definition.sourceFiles;
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 128 ||
    new Set(files).size !== files.length
  )
    throw Error('Evaluation source list must contain 1–128 unique files.');
  files.forEach(relativeFile);
  if ((await fs.lstat(root)).isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw Error('Evaluation source root must be canonical.');
  const state = await repositoryState(root);
  if (state.head !== definition.sourceCommit || !state.clean)
    throw Error('Evaluation source must match its recorded clean commit.');
  const { safeGit } = await import('../../adapters/processes/safe-git.ts');
  const tracked = new Set(
    (await safeGit(['ls-files', '-z', '--', ...files], { cwd: root })).stdout.split('\0'),
  );
  const entries = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!tracked.has(file)) throw Error('Evaluation sources must be tracked files.');
    const bytes = await sourceBytes(root, file);
    totalBytes += bytes.length;
    if (totalBytes > 8 * 1024 * 1024)
      throw Error('Evaluation source copy exceeds the total size limit.');
    const digest = hash(bytes);
    if (definition.sourceHashes?.[file] && definition.sourceHashes[file] !== digest)
      throw Error('Evaluation source does not match its recorded file hash.');
    entries.push({ file, bytes, digest });
  }
  const snapshot = {
    root,
    ...state,
    hashes: Object.fromEntries(entries.map(({ file, digest }) => [file, digest])),
  };
  await assertSourceUnchanged(snapshot);
  return { snapshot, entries };
}
async function assertSourceUnchanged(snapshot) {
  const current = await repositoryState(snapshot.root);
  if (current.head !== snapshot.head || current.statusHash !== snapshot.statusHash)
    throw Error('Original repository state changed during evaluation.');
  for (const [file, digest] of Object.entries(snapshot.hashes))
    if (hash(await sourceBytes(snapshot.root, file)) !== digest)
      throw Error('Original evaluation source changed.');
  return true;
}
async function prepareSourceFixture(definition) {
  const { snapshot, entries } = await captureSource(definition);
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-source-evaluation-')),
  );
  try {
    for (const { file, bytes } of entries) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    await assertSourceUnchanged(snapshot);
    return {
      root,
      provenance: snapshot,
      assertOriginalUnchanged: () => assertSourceUnchanged(snapshot),
      cleanup: () => fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { prepareSourceFixture, captureSource, assertSourceUnchanged };
