/**
 * `nextjs-harness mcp status` — is the server registered, and can it answer?
 *
 * Registration is per coding agent, so the answer is per coding agent too: a
 * project set up for Claude Code and Cursor can easily be registered with one
 * and not the other, and a single yes/no would hide exactly that.
 */
import { logger } from '../../../logger.js';
import { inspectRegistrations } from '../../../generators/targets/mcp.js';
import { TARGETS } from '../../../generators/targets/registry.js';
import { loadContext } from '../../context.js';
import { collectStatus } from '../manuals/status.js';

export interface McpStatusOptions {
  cwd?: string;
  json?: boolean;
}

export async function mcpStatusCommand(options: McpStatusOptions = {}): Promise<void> {
  const { config, project } = await loadContext(options.cwd);
  const registrations = await inspectRegistrations(
    project.root,
    config.targets,
    config.mcp.serverName,
  );
  const manuals = await collectStatus({ cwd: options.cwd });

  const report = {
    serverName: config.mcp.serverName,
    transport: config.mcp.transport,
    targets: registrations.map((state) => ({
      target: state.target,
      label: state.label,
      registered: state.registered,
      current: state.current,
      configFile: state.relativeFile,
    })),
    documentationReady: manuals.indexed,
    documentCount: manuals.documentCount,
    version: manuals.docsLine,
    tools: ['search_nextjs_manual', 'get_nextjs_manual', 'search_nextjs_api'],
  };

  if (options.json) {
    logger.print(JSON.stringify(report, null, 2));
    return;
  }

  logger.print(`Server name:      ${report.serverName}`);
  logger.print(`Transport:        ${report.transport}`);
  logger.print(`Documentation:    nextjs-${report.version}`);
  logger.print();

  for (const state of registrations) {
    if (state.registered) {
      logger.success(`Registered with ${state.label} in ${state.relativeFile}`);
      if (!state.current) {
        logger.info('The entry differs from the default — assuming this is intentional.');
      }
    } else {
      logger.warn(`Not registered with ${state.label}`);
    }
  }

  if (registrations.some((state) => !state.registered)) {
    logger.print();
    logger.print('Run:');
    logger.print('  nextjs-harness setup');
  }

  logger.print();

  if (report.documentationReady) {
    logger.success(`Documentation index ready — ${report.documentCount} documents`);
  } else {
    logger.warn('Documentation index is empty — the MCP tools will return an error');
    logger.print();
    logger.print('Run:');
    logger.print('  nextjs-harness manuals update');
  }

  logger.print();
  logger.print('Tools:');
  for (const tool of report.tools) {
    logger.print(`  ${tool}`);
  }
  logger.print();
  logger.print(`Agents: ${config.targets.map((id) => TARGETS[id].label).join(', ')}`);
}