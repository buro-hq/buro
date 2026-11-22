import { operationIds } from '../../core/operation-catalog.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ExecutionEnvironmentPort } from '../../core/environment-ports.ts';
import {
  DomainError,
  type AgentRuntime,
  type ProjectRegistry,
  type RuntimeSelection,
} from '../../core/ports.ts';
import type { Check } from '../../protocol/domain.ts';
import {
  EnvironmentRecipeSchema,
  environmentRecipeOutputSchema,
  parseEnvironmentRecipeOutput,
  type EnvironmentRecipe,
} from '../../protocol/environment.ts';
import { runProjectCommand } from '../checks/project-commands.ts';
import { EnvironmentExecutors } from './executors.ts';

type Input = Parameters<ExecutionEnvironmentPort['prepare']>[0];
/** Recipes are project data. Installation, readiness, and bounded repair share one execution world. */
export class ProjectEnvironments implements ExecutionEnvironmentPort {
  readonly projects: ProjectRegistry;
  readonly runtime: AgentRuntime;
  readonly executors: EnvironmentExecutors;
  readonly selection?: RuntimeSelection;
  constructor(
    projects: ProjectRegistry,
    runtime: AgentRuntime,
    executors: EnvironmentExecutors,
    selection?: RuntimeSelection,
  ) {
    this.projects = projects;
    this.runtime = runtime;
    this.executors = executors;
    this.selection = selection;
  }
  async prepare(input: Input): Promise<Check> {
    const started = performance.now();
    const root = this.projects.get(input.projectId).snapshot().project.root;
    const config = input.profile.environment || { provider: 'native' as const };
    const owner = this.projects
      .get(input.projectId)
      .snapshot()
      .runs.find((run) => run.id === input.runId);
    const resources = owner?.resources || this.selection?.forProject(input.projectId);
    const privateDataIsolation =
      !!resources &&
      [
        resources.coordinator,
        resources.worker,
        resources.reviewer,
        ...(resources.workerPool || []),
      ].some((resource) => resource.capabilities.hostToolLifecycle);
    let world;
    try {
      world = await this.executors.register(input.workspace, root, config, input.signal, {
        privateDataIsolation,
      });
    } catch (error) {
      input.signal.throwIfAborted();
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'Could not start the execution environment: ' + String(error),
      );
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          input.base,
          input.profile.context,
          input.profile.setup,
          config,
          process.platform,
          process.arch,
        ]),
      )
      .digest('hex');
    const cacheDirectory = path.join(root, '.buro', 'local', 'environment-recipes');
    await safeDirectory(cacheDirectory);
    const cached = path.join(cacheDirectory, key + '.json');
    const stateDirectory = path.join(input.workspace, '.buro', 'environment');
    await safeDirectory(stateDirectory);
    const stateFile = path.join(stateDirectory, 'state.json');
    const saved = await readJSON(stateFile);
    let recipe: EnvironmentRecipe | undefined = config.recipe;
    let cacheHit = !!recipe;
    if (!recipe) {
      const state = EnvironmentRecipeSchema.safeParse(saved?.recipe);
      const cache = EnvironmentRecipeSchema.safeParse(await readJSON(cached));
      if (saved?.key === key && state.success) {
        recipe = state.data;
        cacheHit = true;
      } else if (cache.success) {
        recipe = cache.data;
        cacheHit = true;
      }
    }
    let failure = '',
      previousFailure = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal.throwIfAborted();
      if (!recipe) {
        const planning = performance.now();
        try {
          recipe = await this.discover(input, failure);
        } catch (error) {
          input.signal.throwIfAborted();
          if (/invalid_json_schema|Invalid schema for response_format/.test(String(error)))
            return {
              name: 'Environment output schema',
              passed: false,
              error: 'The runtime rejected the environment output schema: ' + String(error),
              durationMs: performance.now() - started,
            };
          failure = 'Invalid environment recipe: ' + String(error);
          if (attempt === 2)
            return {
              name: 'Project environment',
              passed: false,
              error: failure,
              durationMs: performance.now() - started,
            };
          continue;
        }
        await input.report({
          name: 'Environment recipe',
          passed: true,
          durationMs: performance.now() - planning,
          output: recipe.summary,
        });
      }
      const variables = { ...world.baseVariables };
      const resolve = (name: string, visiting = new Set<string>()): string => {
        if (name === 'WORKSPACE') return input.workspace;
        if (visiting.has(name)) {
          if (name in world.baseVariables) return world.baseVariables[name];
          throw Error('Cyclic environment variable: ' + name);
        }
        const raw = recipe!.variables?.[name];
        if (raw === undefined) {
          if (name in variables) return variables[name];
          throw Error('Unknown environment variable: ' + name);
        }
        const next = new Set(visiting).add(name);
        return raw.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key) => resolve(key, next));
      };
      for (const name of Object.keys(recipe.variables || {})) variables[name] = resolve(name);
      world.variables = variables;
      const fingerprint = await this.fingerprint(input.workspace, recipe, config);
      // Fingerprints only skip setup. Readiness always executes, including after service restart.
      let ready: Check[] = [];
      if (saved?.key === key && saved.fingerprint === fingerprint)
        ready = await this.commands(input, recipe.ready, 'ready');
      if (!ready.length || ready.some((check) => !check.passed)) {
        const setup = await this.commands(
          input,
          [
            ...input.profile.setup,
            ...recipe.setup.filter(
              (command) =>
                !input.profile.setup.some((existing) => existing.command === command.command),
            ),
          ],
          'setup',
        );
        const failed = setup.find((check) => !check.passed);
        ready = failed ? [failed] : await this.commands(input, recipe.ready, 'ready');
      }
      const failed = ready.find((check) => !check.passed);
      if (!failed) {
        const finalFingerprint = await this.fingerprint(input.workspace, recipe, config);
        await atomicJSON(stateFile, { key, fingerprint: finalFingerprint, recipe });
        await atomicJSON(cached, recipe);
        return {
          name: 'Project environment',
          passed: true,
          durationMs: performance.now() - started,
          output: `${cacheHit ? 'Reused' : 'Prepared'} project recipe; readiness verified in ${world.config.provider}.`,
        };
      }
      failure = JSON.stringify({
        command: failed.command,
        exitCode: failed.exitCode,
        output: failed.output?.slice(-6000),
      });
      const signature = createHash('sha256')
        .update(JSON.stringify([recipe, failure]))
        .digest('hex');
      if (signature === previousFailure || failed.exitCode === -1 || config.recipe || attempt === 2)
        return {
          name: 'Project environment',
          passed: false,
          durationMs: performance.now() - started,
          output: failed.output,
          error: failed.error || failure,
          command: failed.command,
        };
      previousFailure = signature;
      recipe = undefined;
      cacheHit = false;
    }
    throw Error('Environment preparation did not settle.');
  }
  private async commands(input: Input, commands: EnvironmentRecipe['setup'], stage: string) {
    const checks: Check[] = [];
    for (const command of commands) {
      input.signal.throwIfAborted();
      const launch = this.executors.launch(input.workspace, ['/bin/sh', '-c', command.command], {
        allowNetwork: true,
        variables: {
          CI: '1',
          PROJECT_ROOT: this.projects.get(input.projectId).snapshot().project.root,
          GOAL_WORKSPACE: input.workspace,
        },
      });
      const result = await runProjectCommand(
        command,
        input.workspace,
        this.projects.get(input.projectId).snapshot().project.root,
        input.signal,
        {},
        launch,
      );
      const check: Check = {
        name: `Environment ${stage}: ${command.title}`,
        command: command.command,
        passed: result.exitCode === 0,
        ...result,
        ...(result.exitCode !== 0
          ? { error: result.output.slice(-3000) || 'Environment command failed.' }
          : {}),
      };
      checks.push(check);
      await input.report(check);
      if (!check.passed) break;
    }
    return checks;
  }
  private async discover(input: Input, failure: string) {
    const thread = await this.runtime.start({
      projectId: input.projectId,
      workspace: input.workspace,
      runId: 'environment-' + input.runId,
      ownerRunId: this.projects
        .get(input.projectId)
        .snapshot()
        .runs.some((run) => run.id === input.runId)
        ? input.runId
        : undefined,
      readOnly: true,
      purpose: 'environment',
      operationId: operationIds.environment,
      instructions:
        'Inspect the project and return an environment recipe. Read only: do not execute setup, edit files, start child agents, access secrets, or change acceptance commands. Use existing documentation, CI, manifests and toolchain configuration as evidence. The service executes setup separately in the selected environment.',
    });
    try {
      if (!this.runtime.turn) throw Error('The runtime cannot discover project environments.');
      const result = await this.runtime.turn(
        thread.threadId,
        `Determine the minimal preparation needed for this repository, without assuming a language or framework. Context: ${input.profile.context}. Existing setup: ${JSON.stringify(input.profile.setup)}. Registered acceptance commands (do not modify or weaken): ${JSON.stringify(input.profile.checks)}.
Return a reusable recipe: variables must always be an array of {name, value} entries (use [] when none); they persist needed toolchain settings across commands (use literal \${WORKSPACE}, \${HOME}, and \${PATH} placeholders; do not replace HOME, CODEX_HOME, TMPDIR or service roots); inputs are exact relative configuration files or directories whose contents determine setup (no globs, generated directories, .git or .buro); setup contains idempotent bounded commands for real toolchain/dependency installation and required generation, including normal lifecycle scripts; ready contains cheap commands that prove required tools and generated/runtime artifacts exist. Use project-local installations and the provided private HOME/cache directories. Do not use sudo, mutate source Git, access shared databases, deploy, or acquire credentials. Do not treat missing credentials or an unavailable OS/runner as a code bug. Do not change tests, scripts or compiler configuration to make setup pass. Empty setup is valid if nothing is needed; readiness must still prove it. Avoid scanning dependency/build directories. Previous preparation failure: ${failure || 'none'}. Return the recipe only.`,
        {
          schema: environmentRecipeOutputSchema,
          signal: input.signal,
          timeoutMs: 600000,
        },
      );
      return parseEnvironmentRecipeOutput(JSON.parse(result.text));
    } finally {
      await this.runtime.release?.(thread.threadId);
    }
  }
  private async fingerprint(workspace: string, recipe: EnvironmentRecipe, config: unknown) {
    const hash = createHash('sha256').update(
      JSON.stringify([2, recipe, config, process.platform, process.arch]),
    );
    let bytes = 0,
      files = 0;
    const visit = async (relative: string) => {
      if (
        relative.split(/[\\/]/).some((part) => ['..', '.git', '.buro'].includes(part)) ||
        path.isAbsolute(relative)
      )
        throw Error(
          'Environment inputs must stay inside the project and exclude service metadata.',
        );
      const target = path.join(workspace, relative);
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hash.update(relative + ':missing');
        return;
      }
      if (stat.isSymbolicLink() || (await fs.realpath(target)) !== target)
        throw Error('Environment inputs must not traverse symlinks.');
      hash.update(JSON.stringify([relative, stat.isDirectory(), stat.size]));
      if (stat.isDirectory()) {
        for (const name of (await fs.readdir(target)).sort())
          await visit(path.join(relative, name));
      } else if (stat.isFile()) {
        bytes += stat.size;
        files++;
        if (bytes > 32 * 1024 * 1024 || files > 10000)
          throw Error('Environment inputs are too broad; select configuration files.');
        hash.update(await fs.readFile(target));
      }
    };
    for (const relative of [...recipe.inputs].sort()) await visit(relative);
    return hash.digest('hex');
  }
  release(workspace: string) {
    return this.executors.release(workspace);
  }
}
async function safeDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.realpath(directory)) !== directory)
    throw Error('Environment state must not traverse symlinks.');
}
async function readJSON(file: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
async function atomicJSON(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
