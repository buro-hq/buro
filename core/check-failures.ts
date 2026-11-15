import type { Check } from '../protocol/domain.ts';
const normalize = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '').trim();
/** Only proven, unchanged declaration errors in dependencies qualify as an environment blocker. */
export function unchangedDependencyFailures(baseline: Check[], current: Check[]) {
  return current
    .filter((check) => {
      if (check.passed) return false;
      const previous = baseline.find(
        (item) => (item.command || item.name) === (check.command || check.name),
      );
      if (!previous || previous.passed) return false;
      const output = normalize(check.output || check.error || ''),
        before = normalize(previous.output || previous.error || '');
      if (!output || output !== before) return false;
      const diagnostics = output.split('\n').filter((line) => /: error TS\d+:/.test(line));
      return diagnostics.length > 0 && diagnostics.every((line) => line.includes('node_modules/'));
    })
    .map((check) => check.name);
}
