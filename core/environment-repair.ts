import type { FileChange } from '../protocol/domain.ts';
import type { ExecutionPolicy } from './execution-ports.ts';
export const dependencyFiles = [
  'package.json',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
];
export function withEnvironmentRepair(policy: ExecutionPolicy, enabled: boolean): ExecutionPolicy {
  return enabled
    ? { ...policy, allowedPaths: [...new Set([...policy.allowedPaths, ...dependencyFiles])] }
    : policy;
}
const dependencyFields = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'resolutions',
  'overrides',
]);
/** Changing dependencies never grants permission to replace scripts or weaken verification. */
export function dependencyManifestPreserved(changes: FileChange[]) {
  const change = changes.find((f) => f.path === 'package.json');
  if (!change) return true;
  try {
    const before = JSON.parse(change.before),
      after = JSON.parse(change.after);
    if (!before || !after || Array.isArray(before) || Array.isArray(after)) return false;
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].every(
      (key) =>
        dependencyFields.has(key) || JSON.stringify(before[key]) === JSON.stringify(after[key]),
    );
  } catch {
    return false;
  }
}
export const environmentRepairInstructions =
  'The user authorized dependency repair for this goal. Additional source changes are limited to dependency fields in package.json and lockfiles; do not change scripts, acceptance commands or compiler configuration. In a managed project environment you may prepare real tools and dependencies, including normal installation scripts, using the supplied private HOME and caches. Keep installations inside that execution environment; do not modify the source checkout, acquire credentials, deploy or alter shared infrastructure. The service verifies environment readiness and runs independent acceptance. If no managed environment was supplied, edit dependency declarations and let the service install them; do not install packages on the host yourself. Never emulate installation, weaken checks or replace real tools with stubs. Fix the environment and bring the original goal to acceptance.';
