/**
 * `nextjs-harness agent install` / `agent update`.
 *
 * Both run the same installer; "update" is the friendlier name for re-running
 * it. Local edits are preserved unless --force is given.
 *
 * The four Next.js roles are installed for every coding agent the project is
 * configured for, as subagents where the tool has them and as its nearest
 * equivalent — a command, or a playbook document — where it does not.
 */
import { requireNextJsProject } from '../../nextjs/project.js';
import { loadConfig } from '../../../generators/config-generator/config.js';
import { installRolesFor, type TargetPartOutcome } from '../../../generators/targets/install.js';
import { parseTargetIds } from '../../../generators/targets/registry.js';
import { reportRoles, type Verb } from '../targets/report.js';

export interface AgentCommandOptions {
  cwd?: string;
  force?: boolean;
  /** Restrict to these agents instead of everything the config lists. */
  target?: readonly string[];
}

export async function runAgentInstall(
  options: AgentCommandOptions = {},
): Promise<TargetPartOutcome[]> {
  const project = await requireNextJsProject(options.cwd);
  // Roles reference MCP tools by their namespaced names, so they need the
  // configured server name. Falls back to the default before `init` has run.
  const config = await loadConfig(project.root);

  const targets = options.target?.length
    ? parseTargetIds(options.target)
    : (config?.targets ?? ['claude-code']);

  return installRolesFor(targets, {
    root: project.root,
    serverName: config?.mcp.serverName ?? 'nextjs-docs',
    cohort: config?.targets,
    force: options.force,
  });
}

export function reportAgentResult(outcomes: readonly TargetPartOutcome[], verb: Verb): void {
  for (const outcome of outcomes) {
    reportRoles(outcome, verb);
  }
}

export async function agentInstallCommand(options: AgentCommandOptions = {}): Promise<void> {
  reportAgentResult(await runAgentInstall(options), 'Installed');
}
