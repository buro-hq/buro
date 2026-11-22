import type { ToolEffect } from '../../core/model-ports.ts';

/** Explicit metadata for small test brokers; production tool policy comes from sealed registrations. */
export function fixtureToolEffect(name: string): ToolEffect {
  if (name === 'edit_file') return 'write';
  if (name === 'run_command') return 'command';
  return 'read';
}
