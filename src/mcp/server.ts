/**
 * The Next.js documentation MCP server.
 *
 * Transport is stdio, which means stdout carries JSON-RPC frames and nothing
 * else. `startMcpServer` redirects all logging to stderr before connecting.
 *
 * The server starts even when the project is not yet synced: failing to start
 * would show up in Claude Code as a broken server, whereas starting and having
 * each tool return an actionable "run manuals update" message is something an
 * agent can act on and relay to the developer.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { logger } from '../logger.js';
import { packageVersion } from '../package-version.js';
import { createMcpContext, type McpContext } from './context.js';
import { registerGetManual } from './tools/get-manual.js';
import { registerSearchApi } from './tools/search-api.js';
import { registerSearchManual } from './tools/search-manual.js';
import { registerSpecTools } from './tools/search-specs.js';

export const SERVER_NAME = 'nextjs-harness';

/**
 * Reported in the MCP handshake, so a client is told which release it is
 * actually talking to. Taken from package.json rather than kept as its own
 * constant, which only ever drifts.
 */
export const SERVER_VERSION = packageVersion();

export function createServer(context: McpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Authoritative Next.js documentation for the version this project actually uses. ' +
        'Consult it before writing Next.js code whose API, configuration or behaviour is uncertain, ' +
        'and prefer what it returns over recalled knowledge — Next.js APIs differ between major versions. ' +
        "Two separate corpora are exposed: the Next.js manual (search_nextjs_manual) and this project's " +
        'own specs (search_project_specs). Keep them distinct — never present a project design note as ' +
        'framework behaviour, or vice versa.',
    },
  );

  registerSearchManual(server, context);
  registerGetManual(server, context);
  registerSearchApi(server, context);
  // Project specs are always registered; the tools explain how to enable
  // indexing when a project has not opted in, which is more useful to an agent
  // than a tool that silently does not exist.
  registerSpecTools(server, context);

  return server;
}

export interface StartMcpServerOptions {
  cwd?: string;
}

export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  // Must happen before anything can print: stdout belongs to the protocol.
  logger.useStderr();

  const cwd = options.cwd ?? process.cwd();
  const context = createMcpContext(cwd);
  const server = createServer(context);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.debug(`Next.js documentation MCP server listening on stdio (project: ${cwd})`);
}
