/**
 * `nextjs-harness targets add <agent...>` — set this project up for another
 * coding agent.
 *
 * Records the agent in the config *and* installs its files immediately: an
 * agent listed but not installed would be a lie the next `doctor` run would
 * have to report.
 */
import { logger } from '../../../logger.js';
import { updateConfig } from '../../../generators/config-generator/config.js';
import { loadContext } from '../../context.js';
import { installTargets } from '../../../generators/targets/install.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import { reportInstructions, reportRoles } from './report.js';
import { registerTargetsInteractively } from './install.js';

export interface TargetsAddOptions {
  cwd?: string;
  yes?: boolean;
  mcp?: boolean;
  force?: boolean;
}

export async function targetsAddCommand(
  ids: readonly string[],
  options: TargetsAddOptions = {},
): Promise<void> {
  const requested = parseTargetIds(ids);
  const { config, project } = await loadContext(options.cwd);

  const added = requested.filter((id) => !config.targets.includes(id));
  const already = requested.filter((id) => config.targets.includes(id));

  for (const id of already) {
    logger.info(`${TARGETS[id].label} is already set up — refreshing its files`);
  }

  if (added.length > 0) {
    await updateConfig(project.root, (current) => ({
      ...current,
      targets: [...current.targets, ...added],
    }));
    logger.success(`Added ${added.map((id) => TARGETS[id].label).join(', ')} to the configuration`);
  }

  logger.print();

  const results = await installTargets(requested, {
    root: project.root,
    serverName: config.mcp.serverName,
    // The agents that will be configured once this command finishes.
    cohort: [...config.targets, ...added],
    force: options.force,
  });

  for (const result of results) {
    logger.print(`${result.target.label}:`);
    reportInstructions({ target: result.target, part: result.instructions }, 'Installed');
    reportRoles({ target: result.target, part: result.roles }, 'Installed');
    logger.print();
  }

  if (options.mcp !== false) {
    await registerTargetsInteractively(project.root, requested, config.mcp.serverName, {
      yes: options.yes,
    });
  }
}
