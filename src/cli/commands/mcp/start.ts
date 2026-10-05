/**
 * `nextjs-harness mcp start` — run the documentation MCP server on stdio.
 *
 * Normally launched by Claude Code rather than by hand.
 */
import { startMcpServer } from '../../../mcp/server.js';

export interface McpStartOptions {
  cwd?: string;
}

export async function mcpStartCommand(options: McpStartOptions = {}): Promise<void> {
  await startMcpServer({ cwd: options.cwd });

  // Resolve only when the transport closes; keep the process alive until then.
  await new Promise<void>((resolve) => {
    process.stdin.once('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}
