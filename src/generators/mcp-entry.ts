/**
 * The one description of how a coding agent should launch this MCP server.
 *
 * Every target writes the same command in its own configuration dialect, so the
 * command itself lives here rather than being repeated per target. `npx`
 * resolves a local install, a global install and a cold cache alike, which is
 * what makes a committed registration work for a whole team.
 *
 * The argument is the **package** name, not the binary name — `npx` resolves
 * packages, and the binary is only reachable once the right package is
 * installed.
 */
export const PACKAGE_NAME = '@andygo.dev/nextjs-harness';

export const MCP_COMMAND = 'npx';

export const MCP_ARGS: readonly string[] = ['-y', PACKAGE_NAME, 'mcp', 'start'];

/** The launch command as a single argv array, for configs that want one list. */
export function mcpCommandLine(): string[] {
  return [MCP_COMMAND, ...MCP_ARGS];
}