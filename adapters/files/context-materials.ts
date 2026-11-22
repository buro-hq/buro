import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type ProjectRegistry } from '../../core/ports.ts';
import type { ContextMaterial } from '../../protocol/context.ts';
import { ContextLoaderCatalog, type ResolvedContextLoader } from '../../core/context-loaders.ts';
import { createBuiltinContextLoaders } from '../context/loaders/builtins.ts';
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const maxFile = 8 * 1024 * 1024,
  maxBatch = 48 * 1024 * 1024;
const skipped = new Set([
  '.git',
  '.buro',
  '.atelier',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  'venv',
  'target',
]);
const denied = (name: string) =>
  (/^\.env(?:$|\.)/.test(name) && name !== '.env.example') ||
  /\.(pem|key|p12|pfx|keystore|exe|dmg|zip|gz|sqlite|db)$/i.test(name);
async function materialDirectory(root: string) {
  let directory = await fs.realpath(root);
  for (const part of ['.buro', 'local', 'context']) {
    directory = path.join(directory, part);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new DomainError(
          'INVALID_CONTEXT_DIRECTORY',
          'The materials directory must be a regular directory.',
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await fs.mkdir(directory, { mode: 0o700 });
    }
  }
  try {
    await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return directory;
}
async function putBlob(directory: string, data: Buffer, extension: string) {
  const hash = digest(data),
    file = path.join(directory, hash + extension);
  try {
    await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(file)) !== hash)
      throw new DomainError('CONTEXT_CORRUPT', 'The saved material copy is corrupted.');
  }
  return { hash, relativePath: 'local/context/' + path.basename(file), file };
}
export class ContextMaterials {
  projects: ProjectRegistry;
  queues = new Map<string, Promise<unknown>>();
  loaders: ContextLoaderCatalog;
  constructor(projects: ProjectRegistry, loaders = createBuiltinContextLoaders()) {
    loaders.assertSealed();
    this.projects = projects;
    this.loaders = loaders;
  }
  import(
    id: string,
    fingerprint: string,
    input: {
      projectId: string;
      scope: 'project' | 'goal';
      paths?: string[];
      upload?: { name: string; base64: string };
    },
  ) {
    const work = (this.queues.get(input.projectId) || Promise.resolve())
      .catch(() => {})
      .then(() => this.performImport(id, fingerprint, input));
    this.queues.set(input.projectId, work);
    void work
      .finally(() => {
        if (this.queues.get(input.projectId) === work) this.queues.delete(input.projectId);
      })
      .catch(() => {});
    return work;
  }
  async performImport(
    id: string,
    fingerprint: string,
    input: {
      projectId: string;
      scope: 'project' | 'goal';
      paths?: string[];
      upload?: { name: string; base64: string };
    },
  ) {
    const store = this.projects.get(input.projectId),
      cached = store.receipt(id, fingerprint);
    if (cached !== undefined) return cached as ContextMaterial[];
    const snapshot = store.snapshot(),
      files: { name: string; data: Buffer; loader: ResolvedContextLoader }[] = [];
    let bytes = 0;
    const add = (name: string, data: Buffer, nested = false) => {
      if (data.length > maxFile)
        throw new DomainError('CONTEXT_LIMIT', 'A material must not exceed 8 MB.');
      const label = name.replace(/[\x00-\x1f]/g, '_').slice(-240);
      let loader: ResolvedContextLoader;
      try {
        loader = this.loaders.select({ name: label, bytes: data });
      } catch (error) {
        if (nested && error instanceof DomainError && error.code === 'UNSUPPORTED_CONTEXT') return;
        throw error;
      }
      if (bytes + data.length > maxBatch || files.length >= 64)
        throw new DomainError('CONTEXT_LIMIT', 'Import up to 64 files totaling 48 MB at a time.');
      bytes += data.length;
      files.push({ name: label, data, loader });
    };
    if (input.upload) {
      if (input.paths?.length)
        throw new DomainError(
          'INVALID_CONTEXT_INPUT',
          'Choose either uploads or filesystem paths.',
        );
      const name = path.basename(input.upload.name);
      if (denied(name))
        throw new DomainError(
          'UNSUPPORTED_CONTEXT',
          'Environment files, keys, archives and executables cannot be attached as context.',
        );
      add(name, Buffer.from(input.upload.base64, 'base64'));
    }
    const walk = async (file: string, label: string, depth: number) => {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (depth > 12)
          throw new DomainError('CONTEXT_LIMIT', 'The materials directory nesting is too deep.');
        if (skipped.has(path.basename(file))) return;
        for (const entry of (await fs.readdir(file, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (entry.name.startsWith('.') || skipped.has(entry.name) || denied(entry.name)) continue;
          await walk(path.join(file, entry.name), label + '/' + entry.name, depth + 1);
        }
      } else if (stat.isFile()) {
        if (denied(path.basename(file)))
          throw new DomainError(
            'UNSUPPORTED_CONTEXT',
            'Environment files, keys, archives and executables cannot be attached as context.',
          );
        if (stat.size > maxFile)
          throw new DomainError('CONTEXT_LIMIT', 'A material must not exceed 8 MB.');
        const data = await fs.readFile(file);
        add(label, data, depth > 0);
      }
    };
    for (const source of input.paths || []) {
      try {
        const file = source.startsWith('~/')
          ? path.join((await import('node:os')).homedir(), source.slice(2))
          : path.resolve(source);
        await walk(file, path.basename(file), 0);
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new DomainError('CONTEXT_UNAVAILABLE', 'Could not read the selected material.');
      }
    }
    if (!files.length)
      throw new DomainError('CONTEXT_EMPTY', 'The selection contains no supported files.');
    const directory = await materialDirectory(snapshot.project.root),
      materials: ContextMaterial[] = [],
      fresh: ContextMaterial[] = [];
    for (const { name, data, loader } of files) {
      const hash = digest(data);
      const existing = [...(snapshot.contextMaterials || []), ...fresh].find(
        (m) =>
          m.active &&
          m.scope === input.scope &&
          m.hash === hash &&
          m.name === name &&
          m.loader?.id === loader.id &&
          m.loader.revision === loader.revision,
      );
      if (existing) {
        materials.push(existing);
        continue;
      }
      const extension = path.extname(name).toLowerCase();
      const loaded = await loader.load(new AbortController().signal);
      const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.txt',
        blob = await putBlob(directory, data, safeExtension);
      const material: ContextMaterial = {
        id: 'M-' + randomUUID(),
        name,
        mimeType: loaded.mimeType,
        representation: loaded.representation,
        loader: { id: loader.id, revision: loader.revision },
        ...(loaded.note ? { note: loaded.note } : {}),
        size: data.length,
        hash,
        relativePath: blob.relativePath,
        scope: input.scope,
        active: true,
        createdAt: new Date().toISOString(),
      };
      if (loaded.text !== undefined) {
        const text = Buffer.from(loaded.text);
        if (!text.equals(data)) {
          const extracted = await putBlob(directory, text, '.txt');
          material.textPath = extracted.relativePath;
          material.textHash = extracted.hash;
        }
      }
      fresh.push(material);
      materials.push(material);
    }
    return store.transact(id, fingerprint, (doc) => {
      if ((doc.contextMaterials?.length || 0) + fresh.length > 1000)
        throw new DomainError('CONTEXT_LIMIT', 'The project material library is full.');
      if (
        input.scope === 'project' &&
        (doc.contextMaterials || []).filter((m) => m.active && m.scope === 'project').length +
          fresh.length >
          64
      )
        throw new DomainError('CONTEXT_LIMIT', 'A project can have up to 64 attached materials.');
      (doc.contextMaterials ??= []).push(...fresh);
      return { result: materials, change: { type: 'context.materials.added', materials: fresh } };
    });
  }
  remove(id: string, fingerprint: string, input: { projectId: string; materialId: string }) {
    return this.projects.get(input.projectId).transact(id, fingerprint, (doc) => {
      const material = doc.contextMaterials?.find((m) => m.id === input.materialId);
      if (!material) throw new DomainError('CONTEXT_NOT_FOUND', 'Material not found.');
      material.active = false;
      return {
        result: { id: material.id },
        change: { type: 'context.material.removed', id: material.id },
      };
    });
  }
  async dispose() {
    await Promise.allSettled([...this.queues.values()]);
  }
}

/** Freeze material bytes inside the run workspace, verifying both stored and staged content. */
export async function stageContextMaterials(
  root: string,
  workspace: string,
  materials: ContextMaterial[],
) {
  if (!materials.length) return;
  const directory = path.join(workspace, '.buro/context');
  for (const folder of [path.join(workspace, '.buro'), directory]) {
    try {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid context directory.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await fs.mkdir(folder, { mode: 0o700 });
    }
  }
  for (const material of materials)
    for (const [relative, expected] of [
      [material.relativePath, material.hash],
      [material.textPath, material.textHash],
    ]) {
      if (!relative || !expected) continue;
      const destination = path.join(directory, path.basename(relative));
      try {
        const stat = await fs.lstat(destination);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          digest(await fs.readFile(destination)) !== expected
        )
          throw Error('The material snapshot changed.');
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const source = path.join(root, '.buro', relative),
        stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Material is unavailable.');
      const data = await fs.readFile(source);
      if (digest(data) !== expected) throw Error('The saved material changed.');
      await fs.writeFile(destination, data, { flag: 'wx', mode: 0o400 });
    }
}
