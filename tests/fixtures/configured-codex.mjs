#!/usr/bin/env node
// Emulates the CLI configuration boundary, not model behavior.
const args = process.argv.slice(2);
if (args.includes('mcp')) {
  if (process.env.PROJECT_CLI_PROBE_OUTPUT) {
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.PROJECT_CLI_PROBE_OUTPUT, process.cwd() + '\n');
  }
  if (!args.includes('features.plugins=false') || !args.includes('features.apps=false')) {
    console.error('Discover servers after disabling plugin-provided transports');
    process.exit(1);
  }
  if (args.some((a) => a.includes('mcp_servers."'))) {
    console.error('Quoted override path');
    process.exit(1);
  }
  console.log(
    JSON.stringify([
      {
        name: 'fixture-server',
        enabled: !args.includes('mcp_servers.fixture-server.enabled=false'),
      },
    ]),
  );
} else await import('./fake-codex.mjs');
