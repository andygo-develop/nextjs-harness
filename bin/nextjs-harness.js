#!/usr/bin/env node
/**
 * Entry shim for the nextjs-harness CLI.
 *
 * `node:sqlite` is stability 1.2 (release candidate) and emits an
 * ExperimentalWarning on some Node versions. That warning is noise for CLI
 * users and, more importantly, it must never be mistaken for protocol output
 * when the MCP server is speaking JSON-RPC over stdio. Warnings already go to
 * stderr, but we drop this specific one so `mcp start` stays quiet.
 */
/**
 * Node's `engines` field is advisory — npm only warns unless engine-strict is
 * set — so check here. Without this, running on Node < 22.13 fails deep inside
 * an import with a bare ERR_UNKNOWN_BUILTIN_MODULE for `node:sqlite`, which
 * gives the user nothing to act on.
 */
// Feature-detect rather than compare version numbers: node:sqlite was
// unflagged in 22.13 *and* 23.4, so a numeric floor either wrongly rejects
// Node 23.4+ or wrongly accepts 23.0-23.3. Asking whether the module actually
// loads is exact, and cheap since we load it regardless.
const { createRequire } = await import('node:module');

try {
  createRequire(import.meta.url)('node:sqlite');
} catch {
  process.stderr.write(
    '✖ nextjs-harness requires Node.js 22.13.0 or newer (or 23.4.0+ on the 23.x line).\n\n' +
      `You are running Node.js ${process.versions.node}, which does not provide the\n` +
      "built-in SQLite module (node:sqlite) that this tool's search index uses.\n\n" +
      'Upgrade Node, for example:\n\n' +
      '  nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = (warning, ...args) => {
  const name = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';

  if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) {
    return;
  }

  return originalEmitWarning(warning, ...args);
};

await import('../dist/cli/index.js');
