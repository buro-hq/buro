import fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createInflate, createDeflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkspaceRevision } from '../../core/workspace-revision.ts';
import type {
  OpenVerificationViewOptions,
  VerificationView,
} from '../../core/verification-view.ts';
import type { ContextMaterial } from '../../protocol/domain.ts';
import { VerificationViewSchema, CheckOutputPathsSchema } from '../../protocol/verification.ts';
import { DomainError } from '../../core/ports.ts';
import { safeGit } from '../processes/safe-git.ts';
import { stageContextMaterials } from './context-materials.ts';

type Entry = { mode: string; type: string; object: string; path: string };
export type VerificationViewHandle = { view: VerificationView; dispose(): Promise<void> };
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const unsupported = (message: string) => new DomainError('VERIFICATION_VIEW_UNAVAILABLE', message);
const privatePart = (part: string) =>
  ['.git', '.buro', '.codex', '.claude', '.aws', '.ssh', '.npm'].includes(part.toLowerCase()) ||
  (part.startsWith('.env') && part !== '.env.example') ||
  ['.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519'].includes(part) ||
  /\.(pem|key|p12|pfx|keystore)$/i.test(part);

function relativeFile(value: string) {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          (privatePart(part) && value !== '.buro/project.json'),
      )
  )
    throw unsupported(
      'A tracked verification input is outside the supported public-file policy: ' +
        JSON.stringify(value),
    );
  return value;
}

async function writableDirectories(root: string) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(root, 0o700);
  for (const name of await fs.readdir(root)) await writableDirectories(path.join(root, name));
}
async function readonlyDirectories(root: string) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.chmod(root, stat.mode & 0o111 ? 0o555 : 0o444);
    return;
  }
  for (const name of await fs.readdir(root)) await readonlyDirectories(path.join(root, name));
  await fs.chmod(root, 0o555);
}

async function validateDependencies(root: string, signal?: AbortSignal) {
  async function inspect(directory: string) {
    signal?.throwIfAborted();
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.realpath(filename);
        } catch {
          throw unsupported('A prepared dependency link cannot be resolved.');
        }
        if (!inside(root, target))
          throw unsupported(
            'A dependency aliases live source or another unbound directory. Prepare isolated dependencies first.',
          );
      } else if (stat.isDirectory()) await inspect(filename);
    }
  }
  await inspect(root);
}

async function writeBlob(
  objects: string,
  object: string,
  destination: string,
  signal?: AbortSignal,
) {
  const output = await fs.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha1');
  let header = Buffer.alloc(0);
  let remaining: number | undefined;
  try {
    for await (const chunk of createReadStream(
      path.join(objects, object.slice(0, 2), object.slice(2)),
    ).pipe(createInflate())) {
      signal?.throwIfAborted();
      hash.update(chunk as Buffer);
      let data = chunk as Buffer;
      if (remaining === undefined) {
        header = Buffer.concat([header, data]);
        const end = header.indexOf(0);
        if (end < 0) {
          if (header.length > 128) throw unsupported('Invalid immutable Git blob header.');
          continue;
        }
        const match = /^blob ([0-9]+)$/.exec(header.subarray(0, end).toString('ascii'));
        if (!match || !Number.isSafeInteger(Number(match[1])))
          throw unsupported('Invalid immutable Git blob.');
        remaining = Number(match[1]);
        data = header.subarray(end + 1);
        header = Buffer.alloc(0);
      }
      remaining -= data.length;
      if (remaining < 0) throw unsupported('An immutable Git blob has inconsistent size.');
      await output.writeFile(data);
    }
    if (remaining !== 0 || hash.digest('hex') !== object)
      throw unsupported('An immutable Git blob failed its byte identity check.');
  } finally {
    await output.close();
  }
}

/** Materialize immutable Git objects. No checkout, filters, source .git pointer or writable source mount. */
export async function materializeVerificationView(input: {
  workspace: string;
  gitDirectory: string;
  contextRoot: string;
  materials: ContextMaterial[];
  dependencyTarget?: string;
  revision: WorkspaceRevision;
  options: OpenVerificationViewOptions;
}): Promise<VerificationViewHandle> {
  const { options, revision } = input;
  options.signal?.throwIfAborted();
  const outputPaths = CheckOutputPathsSchema.parse(options.outputPaths);
  for (let index = 0; index < outputPaths.length; index++) {
    const output = outputPaths[index];
    if (
      output
        .split('/')
        .some((part) => privatePart(part) || part.toLowerCase() === 'node_modules') ||
      outputPaths.slice(index + 1).some((other) => overlap(output, other))
    )
      throw unsupported('Writable output directories must be separate and outside private inputs.');
  }
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-verification-')),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    try {
      await writableDirectories(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rm(temporary, { recursive: true, force: true });
    disposed = true;
  };
  try {
    const readRoot = path.join(temporary, 'input');
    const outputRoot = path.join(temporary, 'output');
    const metadata = path.join(readRoot, '.git');
    const objects = path.join(metadata, 'objects');
    const scratch = path.join(temporary, 'scratch');
    await fs.mkdir(objects, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(metadata, 'refs'), { mode: 0o700 });
    await fs.mkdir(path.join(metadata, 'info'), { mode: 0o700 });
    await fs.mkdir(outputRoot, { mode: 0o700 });
    await fs.mkdir(scratch, { mode: 0o700 });
    await fs.writeFile(path.join(metadata, 'HEAD'), revision.base + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(metadata, 'shallow'), revision.base + '\n', { mode: 0o600 });
    await fs.writeFile(
      path.join(metadata, 'config'),
      '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\n',
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(metadata, 'info', 'exclude'), '*\n', { mode: 0o600 });
    const sourceOptions = {
      cwd: input.workspace,
      gitDirectory: input.gitDirectory,
      signal: options.signal,
    };
    const viewOptions = { cwd: readRoot, gitDirectory: metadata, signal: options.signal };
    const sourceObjectRoot = path.join(
      (
        await safeGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], sourceOptions)
      ).stdout.trim(),
      'objects',
    );
    const entries: Entry[] = [];
    for (const record of (
      await safeGit(['ls-tree', '-r', '-z', revision.tree], sourceOptions)
    ).stdout
      .split('\0')
      .filter(Boolean)) {
      const split = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, split).split(' ');
      const filename = relativeFile(record.slice(split + 1));
      if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode))
        throw unsupported(
          'Verification views currently require regular source files and internal relative links, not submodules.',
        );
      entries.push({ mode, type, object, path: filename });
    }
    // Native read-only Git commands can inspect baseline blobs too, so do not copy a
    // secret merely because it was deleted from the candidate revision.
    for (const filename of (
      await safeGit(['ls-tree', '-r', '--name-only', '-z', revision.base], sourceOptions)
    ).stdout
      .split('\0')
      .filter(Boolean))
      relativeFile(filename);
    for (const output of outputPaths)
      if (entries.some((entry) => overlap(entry.path, output)))
        throw unsupported('A writable output directory overlaps captured source input: ' + output);

    async function copyObject(object: string) {
      options.signal?.throwIfAborted();
      if (!/^[a-f0-9]{40}$/.test(object))
        throw unsupported('Invalid immutable verification object.');
      const destination = path.join(objects, object.slice(0, 2), object.slice(2));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try {
        const source = path.join(sourceObjectRoot, object.slice(0, 2), object.slice(2));
        const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw unsupported('An immutable Git object is not a regular file.');
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        const hash = createHash('sha1');
        for await (const chunk of createReadStream(destination).pipe(createInflate())) {
          options.signal?.throwIfAborted();
          hash.update(chunk as Buffer);
        }
        if (hash.digest('hex') !== object)
          throw unsupported('A copied Git object failed its content identity check.');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const type = (await safeGit(['cat-file', '-t', object], sourceOptions)).stdout.trim();
      if (!['commit', 'tree', 'blob'].includes(type))
        throw unsupported('Unsupported verification object type.');
      const body = path.join(scratch, object);
      await safeGit(['cat-file', type, object], { ...sourceOptions, stdoutFile: body });
      const stat = await fs.stat(body);
      const header = Buffer.from(`${type} ${stat.size}\0`);
      const hash = createHash('sha1').update(header);
      const stream = Readable.from(
        (async function* () {
          yield header;
          for await (const chunk of createReadStream(body)) {
            options.signal?.throwIfAborted();
            hash.update(chunk as Buffer);
            yield chunk;
          }
        })(),
      );
      await pipeline(
        stream,
        createDeflate(),
        createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      );
      await fs.unlink(body);
      if (hash.digest('hex') !== object)
        throw unsupported('A Git object failed its immutable identity check.');
    }
    const objectIds = new Set(
      (
        await safeGit(
          ['rev-list', '--objects', '--no-object-names', `${revision.base}^{tree}`, revision.tree],
          sourceOptions,
        )
      ).stdout
        .split(/\s+/)
        .filter(Boolean),
    );
    objectIds.add(revision.base);
    for (const object of objectIds) await copyObject(object);
    await safeGit(['read-tree', revision.tree], viewOptions);

    const links: { path: string; target: string }[] = [];
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const destination = path.join(readRoot, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (entry.mode === '120000') {
        const linkFile = path.join(scratch, 'link');
        await writeBlob(objects, entry.object, linkFile, options.signal);
        const link = await fs.readFile(linkFile, 'utf8');
        await fs.unlink(linkFile);
        const target = path.resolve(path.dirname(destination), link);
        if (
          path.isAbsolute(link) ||
          link.includes('\\') ||
          !inside(readRoot, target) ||
          (path.relative(readRoot, target) !== '.buro/project.json' &&
            path.relative(readRoot, target).split(path.sep).some(privatePart)) ||
          outputPaths.some((output) => overlap(path.join(readRoot, output), target))
        )
          throw unsupported(
            'A source link escapes immutable input or points into writable outputs.',
          );
        links.push({ path: destination, target: link });
      } else {
        await writeBlob(objects, entry.object, destination, options.signal);
        await fs.chmod(destination, entry.mode === '100755' ? 0o555 : 0o444);
      }
    }
    for (const link of links) await fs.symlink(link.target, link.path);
    for (const link of links) {
      try {
        if (!inside(readRoot, await fs.realpath(link.path)))
          throw unsupported('A source link resolves outside immutable input.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const readonlyDependencies: { path: string; target: string }[] = [];
    if (
      input.dependencyTarget &&
      !entries.some(
        (entry) => entry.path === 'node_modules' || entry.path.startsWith('node_modules/'),
      )
    ) {
      try {
        const target = await fs.realpath(input.dependencyTarget);
        if (!(await fs.stat(target)).isDirectory() || path.basename(target) !== 'node_modules')
          throw unsupported('Prepared dependencies must be a regular node_modules directory.');
        await validateDependencies(target, options.signal);
        const mount = path.join(readRoot, 'node_modules');
        await fs.symlink(target, mount, 'dir');
        readonlyDependencies.push({ path: mount, target });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await stageContextMaterials(input.contextRoot, readRoot, input.materials);
    for (const output of outputPaths) {
      const target = path.join(outputRoot, output);
      const mount = path.join(readRoot, output);
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(mount), { recursive: true, mode: 0o700 });
      await fs.symlink(target, mount, 'dir');
    }
    await readonlyDirectories(readRoot);
    await fs.rm(scratch, { recursive: true, force: true });
    options.signal?.throwIfAborted();
    const view = VerificationViewSchema.parse({
      version: 1,
      id: 'verification-' + randomUUID(),
      projectId: options.projectId,
      runId: options.runId,
      sourceWorkspace: input.workspace,
      readRoot,
      outputRoot,
      base: revision.base,
      tree: revision.tree,
      outputPaths,
      ...(readonlyDependencies.length ? { readonlyDependencies } : {}),
    });
    Object.freeze(view.outputPaths);
    for (const dependency of view.readonlyDependencies || []) Object.freeze(dependency);
    if (view.readonlyDependencies) Object.freeze(view.readonlyDependencies);
    return { view: Object.freeze(view), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
