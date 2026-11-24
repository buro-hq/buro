#!/usr/bin/env node
// Emulates the native process configuration boundary, not model behavior.
const args = process.argv.slice(2);
if (
  !args.includes('mcp_servers={}') ||
  !args.includes('features.plugins=false') ||
  !args.includes('features.apps=false')
) {
  console.error('Native process inherited external tools');
  process.exit(1);
}
if (process.env.PROJECT_CLI_PROBE_OUTPUT) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.PROJECT_CLI_PROBE_OUTPUT, process.cwd() + '\n');
}
await import('./fake-codex.mjs');
