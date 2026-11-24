function toml(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(toml).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + '=' + toml(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** Keeps native workspace effects in the registered host tools, independently of agent instructions. */
export function codexArguments(input: { prefix?: string[]; deniedPaths?: string[] } = {}): {
  args: string[];
  permissions: string;
} {
  const permissions = 'buro_tool_host';
  const filesystem: Record<string, string> = { '/': 'deny', ':minimal': 'read' };
  for (const target of [
    os.homedir(),
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    ...(input.deniedPaths ?? []),
  ]) {
    filesystem[path.resolve(target)] = 'deny';
    if (existsSync(target)) filesystem[realpathSync(target)] = 'deny';
  }
  const settings: Record<string, unknown> = {
    [`permissions.${permissions}`]: {
      filesystem,
      network: { enabled: false },
    },
    default_permissions: permissions,
    mcp_servers: {},
    'features.apps': false,
    'features.plugins': false,
    'features.remote_plugin': false,
    'features.hooks': false,
    'features.memories': false,
    'features.goals': false,
    'features.in_app_browser': false,
    web_search: 'disabled',
    'shell_environment_policy.inherit': 'none',
  };
  return {
    permissions,
    args: [
      ...(input.prefix ?? []),
      ...Object.entries(settings).flatMap(([key, value]) => ['-c', key + '=' + toml(value)]),
      'app-server',
      '--stdio',
    ],
  };
}
import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
