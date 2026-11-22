import type { CheckRecipeContribution } from '../../../core/check-recipes.ts';

/** Existing Node discovery is a registered proposal factory, never a package-script executor. */
export function nodeCheckRecipe(): CheckRecipeContribution {
  return {
    id: 'node',
    revision: 'node-check-recipes-v1',
    label: 'Node package scripts',
    inputs: [
      { path: 'package.json', kind: 'text' },
      { path: 'yarn.lock', kind: 'file' },
      { path: 'pnpm-lock.yaml', kind: 'file' },
      { path: 'node_modules', kind: 'directory' },
    ],
    propose(facts) {
      const manifest = facts.entries.find((entry) => entry.path === 'package.json');
      if (!manifest || manifest.kind !== 'text' || !manifest.exists) return undefined;
      const warnings: string[] = [];
      let pkg: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(manifest.content);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('package');
        pkg = value as Record<string, unknown>;
      } catch {
        return {
          checks: [],
          defaultCheckIds: [],
          setup: [],
          warnings: ['Could not parse package.json. Configure check commands explicitly.'],
        };
      }
      const present = (name: string) =>
        facts.entries.some((entry) => entry.path === name && entry.exists);
      const declaredManager =
        typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
      const manager =
        declaredManager ||
        (present('yarn.lock') ? 'yarn' : present('pnpm-lock.yaml') ? 'pnpm' : 'npm');
      const supported = ['npm', 'yarn', 'pnpm', 'bun'].includes(manager);
      if (!supported)
        warnings.push(
          'The declared package manager is not supported by this recipe. Configure check commands explicitly.',
        );
      const scripts =
        pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
          ? (pkg.scripts as Record<string, unknown>)
          : {};
      const titles: Record<string, string> = {
        test: 'Tests',
        typecheck: 'Type check',
        check: 'Project check',
        lint: 'Lint',
      };
      const checks = supported
        ? ['test', 'typecheck', 'check', 'lint']
            .filter((id) => typeof scripts[id] === 'string')
            .map((id) => ({
              id,
              title: titles[id],
              command: `${manager} run ${id}`,
              timeoutMs: 180000,
            }))
        : [];
      if (pkg.workspaces)
        warnings.push(
          'This is a monorepo. Configure workspace dependency setup to verify changed packages; shared node_modules may point to the source checkout.',
        );
      const projectName =
        typeof pkg.name === 'string' && pkg.name.trim().length && pkg.name.trim().length <= 120
          ? pkg.name.trim()
          : undefined;
      return {
        checks,
        defaultCheckIds: checks.slice(0, 1).map((check) => check.id),
        setup: [],
        warnings,
        ...(projectName ? { projectName } : {}),
        ...(!pkg.workspaces && present('node_modules')
          ? { dependencies: 'link-node-modules' as const }
          : {}),
      };
    },
  };
}
