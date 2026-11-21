import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { CheckPort } from '../../core/execution-ports.ts';
import type { Check } from '../../protocol/domain.ts';
import type { VerificationView } from '../../protocol/verification.ts';
import { DomainError } from '../../core/ports.ts';
export type TrustedCheck = {
  id: string;
  title: string;
  script: string;
  /** Host-registered original repository root; resolve its script from the frozen revision. */
  sourceRoot?: string;
};
const inside = (root: string, filename: string) =>
  filename === root || filename.startsWith(root + path.sep);
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
type RegisteredCheck = Readonly<TrustedCheck & { digest?: string; content?: Buffer }>;

async function pinnedScriptCopy(check: RegisteredCheck) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'buro-trusted-entrypoint-')),
  );
  const dispose = async () => {
    await fs.chmod(directory, 0o700).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const script = path.join(directory, 'entrypoint' + path.extname(check.script));
    await fs.writeFile(script, check.content!, { flag: 'wx', mode: 0o400 });
    await fs.chmod(directory, 0o500);
    return { script, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function trustedScript(check: TrustedCheck, view?: VerificationView) {
  if (!view) return fs.realpath(check.script);
  const registered = path.resolve(check.script);
  let sourceRoot = view.sourceWorkspace;
  if (check.sourceRoot) {
    sourceRoot = await fs.realpath(check.sourceRoot);
    if (sourceRoot !== path.resolve(check.sourceRoot))
      throw new DomainError(
        'VERIFICATION_VIEW_CHANGED',
        'A trusted repository check requires a canonical source root.',
      );
    if (!inside(sourceRoot, registered))
      throw new DomainError(
        'VERIFICATION_VIEW_CHANGED',
        'The trusted check is outside its registered repository root.',
      );
  }
  const frozen = inside(sourceRoot, registered) || inside(view.readRoot, registered);
  const candidate = inside(sourceRoot, registered)
    ? path.join(view.readRoot, path.relative(sourceRoot, registered))
    : registered;
  let script: string;
  try {
    script = await fs.realpath(candidate);
    if (
      !(await fs.stat(script)).isFile() ||
      (frozen && !inside(view.readRoot, script)) ||
      (!frozen && inside(view.sourceWorkspace, script))
    )
      throw Error('The check is not a regular frozen input.');
  } catch {
    throw new DomainError(
      'VERIFICATION_VIEW_CHANGED',
      'The trusted check is missing from its frozen revision or resolves outside its input view.',
    );
  }
  return script;
}
export class NodeChecks implements CheckPort {
  private readonly checks = new Map<string, RegisteredCheck[]>();
  constructor(checks: Record<string, TrustedCheck[]>) {
    for (const [projectId, definitions] of Object.entries(checks))
      this.checks.set(
        projectId,
        definitions.map((definition) => {
          // Pin the trusted entrypoint before returning control to any model dispatch.
          // Imported test/module dependencies are a separate policy, not covered by this pin.
          const check: TrustedCheck = {
            id: definition.id,
            title: definition.title,
            script: path.resolve(definition.script),
            ...(definition.sourceRoot ? { sourceRoot: path.resolve(definition.sourceRoot) } : {}),
          };
          try {
            const content = readFileSync(check.script);
            return Object.freeze({ ...check, digest: digest(content), content });
          } catch {
            // A missing definition cannot silently become trusted when a file appears later.
            return Object.freeze(check);
          }
        }),
      );
  }
  async run(
    projectId: string,
    workspace: string,
    ids: string[],
    signal: AbortSignal,
    _profile?: import('../../protocol/domain.ts').ProjectProfile,
    options: { verificationView?: VerificationView } = {},
  ) {
    if (
      options.verificationView &&
      (options.verificationView.projectId !== projectId ||
        ![options.verificationView.sourceWorkspace, options.verificationView.readRoot].includes(
          workspace,
        ))
    )
      throw new DomainError(
        'VERIFICATION_VIEW_CHANGED',
        'The trusted check received another verification view.',
      );
    const readRoot = options.verificationView?.readRoot || workspace;
    const results: Check[] = [];
    for (const id of ids) {
      if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
      const check = this.checks.get(projectId)?.find((c) => c.id === id);
      if (!check) throw Error('Check is not registered.');
      const script = await trustedScript(check, options.verificationView);
      let matches = false;
      try {
        matches = check.digest !== undefined && digest(await fs.readFile(script)) === check.digest;
      } catch {}
      if (!matches)
        throw new DomainError(
          'CHECK_DEFINITION_CHANGED',
          'The trusted check entrypoint no longer matches its registered definition. Register the intended check version before running it.',
        );
      const copy =
        options.verificationView && inside(readRoot, script)
          ? undefined
          : await pinnedScriptCopy(check);
      let outcome: { code: number | null; stdout: string; stderr: string };
      try {
        signal.throwIfAborted();
        const entrypoint = copy?.script || script;
        outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--permission',
                `--allow-fs-read=${readRoot}`,
                // Standalone trusted scripts get one file, never their live source directory.
                // Relative dependencies must be supplied as frozen inputs inside the view.
                `--allow-fs-read=${entrypoint}`,
                entrypoint,
              ],
              {
                cwd: readRoot,
                env: { PATH: process.env.PATH, GOAL_WORKSPACE: readRoot },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            let stdout = '',
              stderr = '';
            const abort = () => child.kill('SIGTERM'),
              timer = setTimeout(() => child.kill('SIGTERM'), 30000);
            signal.addEventListener('abort', abort, { once: true });
            child.stdout.on('data', (b) => (stdout += b));
            child.stderr.on('data', (b) => (stderr += b));
            child.once('error', (error) => {
              clearTimeout(timer);
              signal.removeEventListener('abort', abort);
              reject(error);
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              signal.removeEventListener('abort', abort);
              resolve({ code, stdout, stderr });
            });
          },
        );
        if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
      } finally {
        await copy?.dispose();
      }
      try {
        const data = JSON.parse(outcome.stdout);
        if (!Array.isArray(data.results) || !data.results.length) throw Error('No check results.');
        for (const item of data.results)
          results.push({
            name: `${id}: ${item.name}`,
            passed: item.passed === true,
            ...(item.error ? { error: String(item.error).slice(0, 2000) } : {}),
          });
        if (outcome.code !== 0 && data.results.every((r: any) => r.passed))
          results.push({
            name: `${id}: exit code`,
            passed: false,
            error: outcome.stderr.slice(-2000),
          });
      } catch {
        results.push({
          name: check.title,
          passed: false,
          error: (outcome.stderr || outcome.stdout || 'The check did not return a report.').slice(
            -3000,
          ),
        });
      }
    }
    return { passed: results.filter((r) => r.passed).length, total: results.length, results };
  }
}
