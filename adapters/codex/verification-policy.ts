import type { VerificationView } from '../../protocol/verification.ts';
import { DomainError } from '../../core/ports.ts';

function inlineToml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + '=' + inlineToml(item))
        .join(',') +
      '}'
    );
  throw new DomainError(
    'ENVIRONMENT_UNAVAILABLE',
    'Unsupported native verification permission value.',
  );
}

/** Per-process named profile. Legacy readOnly has unrestricted host reads and cannot substitute for this. */
export function nativeVerificationPolicy(
  view: VerificationView,
  access: {
    readRoots: string[];
    deniedRoots: string[];
  },
  projectRoot: string,
) {
  const id = 'buro_verification_' + view.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filesystem: Record<string, string> = { '/': 'deny', ':minimal': 'read' };
  // :minimal permits some platform temporary reads. Explicitly exclude common temp
  // areas and all original/private roots, then grant only issued input/toolchain roots.
  for (const root of [...access.deniedRoots, projectRoot, view.sourceWorkspace])
    filesystem[root] = 'deny';
  for (const root of [...access.readRoots, view.readRoot, view.outputRoot]) {
    if (
      !root.startsWith('/') ||
      root === '/' ||
      /[\0\r\n]/.test(root) ||
      root === projectRoot ||
      root === view.sourceWorkspace ||
      access.deniedRoots.includes(root)
    )
      throw new DomainError(
        'ENVIRONMENT_UNAVAILABLE',
        'A native review root would expose original source.',
      );
    filesystem[root] = 'read';
  }
  return {
    id,
    argument: `permissions.${id}=${inlineToml({ filesystem, network: { enabled: false } })}`,
  };
}
