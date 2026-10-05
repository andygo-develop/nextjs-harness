/**
 * The package's own version, read from its package.json.
 *
 * Not a hardcoded constant, and not `process.env.npm_package_version` either:
 * that variable only exists when the process was started by an npm script, so
 * it is empty for exactly the ways this CLI is normally run — a global install,
 * `npx`, or an MCP server launched by a coding agent. Reporting a stale
 * hardcoded version to `--version` and in the MCP handshake makes bug reports
 * name the wrong release.
 *
 * Both `src/` and `dist/` sit one level below the package root, so the same
 * relative lookup works whether this is the compiled build or the sources
 * under test.
 */
import { readFileSync } from 'node:fs';

/** Fallback when package.json cannot be read, e.g. a partial install. */
const UNKNOWN_VERSION = '0.0.0';

let cached: string | undefined;

export function packageVersion(): string {
  if (cached !== undefined) {
    return cached;
  }

  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const { version } = JSON.parse(raw) as { version?: unknown };
    cached = typeof version === 'string' && version ? version : UNKNOWN_VERSION;
  } catch {
    cached = UNKNOWN_VERSION;
  }

  return cached;
}
