import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DomainError, type ProjectRegistry } from '../../core/ports.ts';
import type { LocalDirectory, LocalEntry } from '../../protocol/context.ts';
export class LocalBrowser {
  projects: ProjectRegistry;
  constructor(projects: ProjectRegistry) {
    this.projects = projects;
  }
  async list(input: {
    path?: string;
    projectId?: string;
    restricted?: boolean;
    showHidden?: boolean;
    query?: string;
  }): Promise<LocalDirectory> {
    const base = input.projectId
      ? this.projects.get(input.projectId).snapshot().project.root
      : undefined;
    if (input.restricted && !base)
      throw new DomainError(
        'PROJECT_REQUIRED',
        'Select a project to browse inside its repository.',
      );
    let folder: string;
    try {
      folder = await fs.realpath(
        input.path
          ? input.path.startsWith('~/')
            ? path.join(os.homedir(), input.path.slice(2))
            : path.resolve(input.path)
          : base || os.homedir(),
      );
      if ((await fs.stat(folder)).isFile()) folder = path.dirname(folder);
    } catch {
      throw new DomainError(
        'DIRECTORY_UNAVAILABLE',
        'Could not open the directory. Check the path and access permissions.',
      );
    }
    const boundary = input.restricted ? await fs.realpath(base!) : undefined;
    if (boundary && folder !== boundary && !folder.startsWith(boundary + path.sep))
      throw new DomainError('OUTSIDE_PROJECT', 'Choose a path inside the repository.');
    let files: import('node:fs').Dirent[];
    try {
      files = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      throw new DomainError('DIRECTORY_UNAVAILABLE', 'Could not read the directory.');
    }
    const query = (input.query || '').toLocaleLowerCase();
    const entries: LocalEntry[] = [];
    for (const stat of files) {
      const name = stat.name;
      if (
        (!input.showHidden && name.startsWith('.')) ||
        (query && !name.toLocaleLowerCase().includes(query))
      )
        continue;
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) continue;
      entries.push({
        name,
        path: path.join(folder, name),
        kind: stat.isDirectory() ? 'directory' : 'file',
        selectable: !stat.isSymbolicLink(),
      });
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
    return {
      path: folder,
      parent: boundary && folder === boundary ? folder : path.dirname(folder),
      home: boundary || os.homedir(),
      entries: entries.slice(0, 1000),
      truncated: entries.length > 1000,
    };
  }
}
