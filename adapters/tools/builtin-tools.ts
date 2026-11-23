import { ToolContributionCatalog } from '../../core/tool-contributions.ts';
import { repositoryToolSchemas as schemas } from './repository-tool-schemas.ts';
export function registerBuiltinRepositoryTools(catalog: ToolContributionCatalog): void {
  catalog.register({
    name: 'read_file',
    revision: 'read-file-v2',
    effect: 'read',
    description:
      'Read text from a repository file, including dependencies. Defaults to 120 lines and 16000 characters; both are configurable. When truncated, pass the returned next cursor to continue, including within a long line.',
    schema: schemas.read_file,
    execute: (input, operations) => operations.readFile(input),
  });
  catalog.register({
    name: 'list_files',
    revision: 'list-files-v1',
    effect: 'read',
    description:
      'List repository files, excluding private metadata and secrets. Dependencies and generated directories are skipped in general scans; pass their path to inspect them explicitly.',
    schema: schemas.list_files,
    execute: (input, operations) => operations.listFiles(input),
  });
  catalog.register({
    name: 'search_text',
    revision: 'search-text-v1',
    effect: 'read',
    description:
      'Find literal text in a repository file or directory, with file names and line numbers. Not a regular expression.',
    schema: schemas.search_text,
    execute: (input, operations) => operations.searchText(input),
  });
  catalog.register({
    name: 'read_diff',
    revision: 'read-diff-v1',
    effect: 'read',
    description:
      'Inspect the actual Git diff against this run base (HEAD outside a run). Secret paths and external diff programs are excluded.',
    schema: schemas.read_diff,
    execute: (_input, operations) => operations.readDiff(),
  });
  catalog.register({
    name: 'edit_file',
    revision: 'edit-file-v1',
    effect: 'write',
    description:
      'Replace one exact, unique oldText occurrence in a permitted file. To create a new file, use empty oldText. Existing files require a nonempty exact match.',
    schema: schemas.edit_file,
    execute: (input, operations) => operations.editFile(input),
  });
  catalog.register({
    name: 'run_command',
    revision: 'run-command-v2',
    effect: 'command',
    description:
      'Run a shell command inside the isolated workspace. Protected files and private data remain inaccessible for mutation. Uses a matching project check timeout or 120000 ms by default; timeoutMs overrides it. Does not replace service checks.',
    schema: schemas.run_command,
    execute: (input, operations) => operations.runCommand(input),
  });
}
export function createBuiltinToolCatalog(): ToolContributionCatalog {
  const catalog = new ToolContributionCatalog();
  registerBuiltinRepositoryTools(catalog);
  return catalog.seal();
}
