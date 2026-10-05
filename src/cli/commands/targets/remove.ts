/**
 * `nextjs-harness targets remove <agent...>` — stop maintaining files for a
 * coding agent.
 *
 * Deliberately does not delete anything. The files it wrote are in the
 * developer's repository, possibly committed and possibly edited, and quietly
 * deleting a rules file because someone changed a config list is not a trade
 * this tool should make. What it stops is *updating* them, and it says exactly
 * what is left behind so removing them by hand is a one-liner.
 */
import { logger } from '../../../logger.js';
import { updateConfig } from '../../../generators/config-generator/config.js';
import { loadContext } from '../../context.js';
import { instructionsLocation, rolesLocation } from './report.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import { HarnessError } from '../../../errors.js';

export interface TargetsRemoveOptions {
  cwd?: string;
}

export async function targetsRemoveCommand(
  ids: readonly string[],
  options: TargetsRemoveOptions = {},
): Promise<void> {
  const requested = parseTargetIds(ids);
  const { config, project } = await loadContext(options.cwd);

  const removed = requested.filter((id) => config.targets.includes(id));
  const remaining = config.targets.filter((id) => !requested.includes(id));

  if (removed.length === 0) {
    logger.info(`Not set up for ${requested.map((id) => TARGETS[id].label).join(', ')} — nothing to do`);
    return;
  }

  if (remaining.length === 0) {
    throw new HarnessError('That would leave the project set up for no coding agent at all.', {
      hint:
        'Keep at least one, or add another first:\n\n  nextjs-harness targets add <agent>\n\n' +
        'Run `nextjs-harness targets list` to see them.',
    });
  }

  await updateConfig(project.root, (current) => ({
    ...current,
    targets: current.targets.filter((id) => !requested.includes(id)),
  }));

  for (const id of removed) {
    const target = TARGETS[id];
    logger.success(`No longer maintaining files for ${target.label}`);
    logger.print(`    ${instructionsLocation(target)}`);
    logger.print(`    ${rolesLocation(target)}/`);
    logger.print(`    ${target.mcp.file} (the "${config.mcp.serverName}" entry)`);
  }

  logger.print();
  logger.info('Those files were left in place — delete them yourself if you want them gone.');
}
