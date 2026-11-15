import type { ProjectProfile, ProjectResearch } from './domain.ts';

/** Add discovered configuration without replacing user-maintained commands or policies. */
export function profileWithResearch(
  profile: ProjectProfile,
  research: ProjectResearch,
): ProjectProfile {
  const components = [...(profile.components || [])];
  const folder = (p: string) => p.replace(/^\.\//, '').replace(/\/$/, '') || '.';
  for (const proposed of research.components || []) {
    if (
      !components.some(
        (existing) =>
          existing.id === proposed.id ||
          (existing.kind === proposed.kind && folder(existing.path) === folder(proposed.path)),
      )
    )
      components.push(proposed);
  }
  const checks = [...profile.checks];
  for (const proposed of research.checks || [])
    if (!checks.some((existing) => existing.id === proposed.id)) checks.push(proposed);
  return {
    ...profile,
    context: profile.context.trim() ? profile.context : research.context || '',
    components,
    checks,
    defaultCheckIds: profile.checks.length
      ? profile.defaultCheckIds
      : checks.slice(0, 1).map((c) => c.id),
  };
}
