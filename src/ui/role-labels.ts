import type { Role } from '../../protocol/domain.ts';
import { t } from '../i18n/index.ts';
import ru from '../i18n/locales/ru.json' with { type: 'json' };
const seeds: Record<string, { title: string; description: string }> = {
  implementer: { title: 'Developer', description: 'Implements agreed changes.' },
  test_author: { title: 'Test author', description: 'Independently verifies task requirements.' },
  reviewer: { title: 'Reviewer', description: 'Checks result correctness.' },
  coordinator: {
    title: 'Coordinator',
    description: 'Coordinates goal work and chooses actions from actual evidence.',
  },
  local_preview: {
    title: 'Local result verification',
    description: 'Prepares a way to inspect a UI, API or another component.',
  },
  delivery_pr: {
    title: 'Pull request preparation',
    description: 'Prepares a branch, PR description and check evidence.',
  },
  production_delivery: {
    title: 'Environment delivery',
    description: 'Coordinates delivery of an accepted commit to staging or production.',
  },
};
/** Localize unchanged seed labels, User role edits remain content. */
export function roleLabels(role: Pick<Role, 'id' | 'title' | 'description'>) {
  const seed = seeds[role.id];
  const translate = (value: string, key: string) =>
    value === key || value === (ru as Record<string, string>)[key] ? t(key) : value;
  return seed
    ? {
        title: translate(role.title, seed.title),
        description: translate(role.description, seed.description),
      }
    : { title: role.title, description: role.description };
}
