/**
 * Installs the Next.js agents into `.claude/agents/`.
 *
 * Every file under `src/templates/agent/` is installed, so adding an agent is a
 * matter of adding a template.
 *
 * Agent definitions name the MCP tools they call, and those names are
 * namespaced by the server's registered name (`mcp__<server>__<tool>`). Since
 * that name is configurable, it is substituted at install time rather than
 * hardcoded — an agent pointing at a server name the project does not use would
 * silently never reach the documentation.
 */
import path from 'node:path';

import {
  installTemplateSet,
  packageTemplateDir,
  type TemplateInstallResult,
} from '../template-installer.js';

export const AGENT_NAMES = [
  'nextjs-expert',
  'nextjs-code-reviewer',
  'nextjs-test-writer',
  'nextjs-planner',
] as const;
const MANIFEST_FILE = '.nextjs-harness-agents.json';

export function agentsDirFor(root: string): string {
  return path.join(root, '.claude', 'agents');
}

export interface InstallAgentOptions {
  root: string;
  /** MCP server name as registered in .mcp.json (default "nextjs-docs"). */
  mcpServerName?: string;
  /** Overwrite locally modified agent files. */
  force?: boolean;
}

export async function installAgents(options: InstallAgentOptions): Promise<TemplateInstallResult> {
  const targetDir = agentsDirFor(options.root);

  return installTemplateSet({
    sourceDir: packageTemplateDir('agent'),
    targetDir,
    // `.claude/agents/` is shared with agents from other tools, so the manifest
    // is a namespaced dotfile rather than a sibling that could be mistaken for
    // an agent definition.
    manifestFile: path.join(targetDir, MANIFEST_FILE),
    templateSet: 'agent',
    replacements: { MCP_SERVER: options.mcpServerName ?? 'nextjs-docs' },
    force: options.force,
  });
}
