import type { Check, FileChange, Role } from '../protocol/domain.ts';

/** Full command output stays in the run record; model prompts carry actionable evidence. */
export function checkContext(checks: { passed: number; total: number; results: Check[] }) {
  return {
    passed: checks.passed,
    total: checks.total,
    results: checks.results.map(
      ({ name, passed, command, exitCode, durationMs, error, output }) => ({
        name,
        passed,
        command,
        exitCode,
        durationMs,
        ...(!passed ? { error, output: excerpt(output || '', 6000) } : {}),
      }),
    ),
  };
}

function excerpt(value: string, limit: number) {
  if (value.length <= limit) return value;
  return (
    value.slice(0, 1500) +
    '\n[Output shortened; complete log is retained in the run.]\n' +
    value.slice(-(limit - 1500))
  );
}

export function changeContext(changes: FileChange[]) {
  return changes.map(({ path, before, after }) => ({
    path,
    beforeCharacters: before.length,
    afterCharacters: after.length,
  }));
}

export function roleContext(roles: Role[]) {
  return roles.map(({ id, version, title, description, kind, runtimePreference }) => ({
    id,
    version,
    title,
    description,
    kind,
    ...(runtimePreference ? { runtimePreference } : {}),
  }));
}
