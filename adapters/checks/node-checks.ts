import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CheckPort } from '../../core/execution-ports.ts';
import type { Check } from '../../protocol/domain.ts';
export type TrustedCheck = { id: string; title: string; script: string };
export class NodeChecks implements CheckPort {
  checks: Record<string, TrustedCheck[]>;
  constructor(checks: Record<string, TrustedCheck[]>) {
    this.checks = checks;
  }
  async run(projectId: string, workspace: string, ids: string[], signal: AbortSignal) {
    const results: Check[] = [];
    for (const id of ids) {
      if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
      const check = this.checks[projectId]?.find((c) => c.id === id);
      if (!check) throw Error('Check is not registered.');
      const script = await fs.realpath(check.script);
      const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--permission',
              `--allow-fs-read=${workspace}`,
              `--allow-fs-read=${path.dirname(script)}`,
              script,
            ],
            {
              cwd: workspace,
              env: { PATH: process.env.PATH, GOAL_WORKSPACE: workspace },
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
          child.once('error', reject);
          child.once('exit', (code) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            resolve({ code, stdout, stderr });
          });
        },
      );
      if (signal.aborted) throw new DOMException('Interrupted', 'AbortError');
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
