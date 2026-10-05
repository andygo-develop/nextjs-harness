/**
 * `nextjs-harness setup` — the one command a new developer runs.
 *
 * Detect → configure → install guidance and roles for each coding agent → sync
 * manuals → index → offer to register the MCP server with each agent.
 *
 * Every step is idempotent, so re-running setup after a `git pull` is a normal,
 * safe way to bring a checkout up to date. The only steps that touch files
 * outside `.nextjs-harness/` and the agents' own directories are the MCP
 * registrations, which ask first — once per agent.
 */
import { AGENT_NAMES } from '../../generators/agent/installer.js';
import { updateConfig } from '../../generators/config-generator/config.js';
import { logger } from '../../logger.js';
import { installTargets } from '../../generators/targets/install.js';
import { parseTargetIds, TARGETS } from '../../generators/targets/registry.js';
import { loadContext } from '../context.js';
import { runInit } from './init.js';
import { reportIndexResult, runIndex } from './manuals/index.js';
import { runSync } from './manuals/sync.js';
import { registerTargetsInteractively } from './targets/install.js';
import { reportInstructions, reportRoles } from './targets/report.js';

export interface SetupOptions {
  cwd?: string;
  /** Assume yes for the MCP registration prompts (for CI and scripts). */
  yes?: boolean;
  /** Skip MCP registration entirely. */
  mcp?: boolean;
  /** Skip manual synchronization (configuration and agent files only). */
  manuals?: boolean;
  /**
   * Coding agents to set up. Defaults to what the config records, which on a
   * fresh project is what `init` detected.
   */
  target?: readonly string[];
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  const step = (n: number, total: number, message: string): void =>
    logger.info(`[${n}/${total}] ${message}`);

  const withManuals = options.manuals !== false;
  const withMcp = options.mcp !== false;
  const requested = options.target?.length ? parseTargetIds(options.target) : undefined;
  const total = 3 + (withManuals ? 2 : 0) + (withMcp ? 1 : 0);
  let n = 0;

  // 1. Detect and configure.
  step(++n, total, 'Detecting Next.js project…');
  const init = await runInit({ cwd: options.cwd, targets: requested });
  logger.success(
    `Next.js ${init.version} detected — documentation line nextjs-${init.docsLine}` +
      (init.created ? ' (configuration created)' : ''),
  );

  // `--target` means "set this project up for exactly these", so it is
  // recorded. `targets add` is the additive one.
  const loaded = await loadContext(options.cwd);
  const project = loaded.project;
  const config =
    requested && !sameTargets(requested, loaded.config.targets)
      ? await updateConfig(project.root, (current) => ({ ...current, targets: [...requested] }))
      : loaded.config;

  const targets = config.targets;
  const labels = targets.map((id) => TARGETS[id].label);
  logger.success(
    `Setting up for: ${labels.join(', ')}` + (init.targetsDetected ? ' (detected)' : ''),
  );

  // 2 & 3. Guidance and roles, for every agent.
  step(++n, total, 'Installing the Next.js guidance…');
  const installed = await installTargets(targets, {
    root: project.root,
    serverName: config.mcp.serverName,
    cohort: config.targets,
  });
  for (const result of installed) {
    reportInstructions({ target: result.target, part: result.instructions }, 'Installed');
  }

  step(++n, total, 'Installing the Next.js roles…');
  for (const result of installed) {
    reportRoles({ target: result.target, part: result.roles }, 'Installed');
  }

  // 4 & 5. Manuals.
  if (withManuals) {
    step(++n, total, 'Synchronizing the Next.js manuals…');
    const sync = await runSync({ cwd: options.cwd });
    logger.success(
      sync.changed
        ? `Synchronized ${sync.fileCount} files (commit ${sync.commit.slice(0, 7)})`
        : `Manuals already current (commit ${sync.commit.slice(0, 7)})`,
    );

    step(++n, total, 'Indexing the documentation…');
    reportIndexResult(await runIndex({ cwd: options.cwd }));
  }

  // 6. MCP registration — the only step that asks.
  if (withMcp) {
    step(++n, total, 'Configuring the MCP integration…');
    await registerTargetsInteractively(project.root, targets, config.mcp.serverName, {
      yes: options.yes,
    });
  }

  logger.print();
  logger.success('Setup complete');
  logger.print();
  logger.print('Try:');
  logger.print('  nextjs-harness manuals search "revalidate data after a server action"');
  logger.print();
  logger.print(`In ${labels.join(', ')} you now have:`);
  logger.print('  Next.js conventions loaded as guidance');
  logger.print(`  roles: ${AGENT_NAMES.join(', ')}`);
  logger.print('  MCP tools: search_nextjs_manual, get_nextjs_manual, search_nextjs_api');
  logger.print();
  logger.print(`Restart ${labels.join(', ')} if already running.`);
}
