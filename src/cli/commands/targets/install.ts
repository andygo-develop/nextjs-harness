/**
 * `nextjs-harness targets install` — install guidance, roles and the MCP
 * registration for every coding agent this project is set up for.
 *
 * `setup` calls the same code. This command exists so a developer who has just
 * added an agent, or pulled a change to the templates, can refresh only the
 * agent-facing files without re-checking the manuals.
 */
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';
import { MCP_ARGS, MCP_COMMAND } from '../../../generators/mcp-entry.js';
import { installTargets, registerTargets } from '../../../generators/targets/install.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import type { TargetRegistrationState } from '../../../generators/targets/mcp.js';
import type { TargetDefinition, TargetId } from '../../../generators/targets/types.js';
import { confirm } from '../../prompt.js';
import { reportInstructions, reportRoles } from './report.js';

export interface TargetsInstallOptions {
  cwd?: string;
  force?: boolean;
  /** Restrict to these agents instead of everything the config lists. */
  target?: readonly string[];
  /** Answer yes to the MCP registration prompts. */
  yes?: boolean;
  /** Skip MCP registration entirely. */
  mcp?: boolean;
}

/**
 * Prints the "here is how to do it by hand" fallback for a declined agent.
 *
 * A declined registration is a normal outcome, not a failure — but leaving the
 * developer to work out the file format themselves would be.
 *
 * The command is rendered from `mcp-entry.ts` rather than spelled out, so this
 * cannot drift into telling people to configure a package name or an argument
 * list the harness itself no longer uses.
 */
export function printManualRegistration(target: TargetDefinition, serverName: string): void {
  const args = MCP_ARGS.map((arg) => JSON.stringify(arg)).join(', ');
  const command = JSON.stringify(MCP_COMMAND);
  const key = JSON.stringify(serverName);

  logger.print();
  logger.print(`To register later, re-run setup or add this to ${target.mcp.file}:`);
  logger.print();

  if (target.mcp.style === 'codex-toml') {
    // TOML bare keys are letters, digits, `_` and `-`; anything else is quoted.
    logger.print(`  [mcp_servers.${/^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : key}]`);
    logger.print(`  command = ${command}`);
    logger.print(`  args = [${args}]`);
    return;
  }

  if (target.mcp.style === 'opencode') {
    logger.print(`  "mcp": { ${key}: {`);
    logger.print('    "type": "local",');
    logger.print(`    "command": [${[command, args].join(', ')}]`);
    logger.print('  } }');
    return;
  }

  logger.print(`  "mcpServers": { ${key}: {`);
  logger.print(`    "command": ${command},`);
  logger.print(`    "args": [${args}]`);
  logger.print('  } }');
}

/** The MCP half of setting up a target, shared with `setup`. */
export async function registerTargetsInteractively(
  root: string,
  targets: readonly TargetId[],
  serverName: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const describe = (target: TargetDefinition, state: TargetRegistrationState): string =>
    state.fileExists
      ? `Add the "${serverName}" server to ${target.mcp.file} for ${target.label}?` +
        (state.otherServers.length > 0
          ? ` (${state.otherServers.length} existing server(s) will be left unchanged)`
          : '')
      : `Create ${target.mcp.file} registering the "${serverName}" MCP server for ${target.label}?`;

  const outcomes = await registerTargets(targets, {
    root,
    serverName,
    confirm: (target, state) => confirm(describe(target, state), { assumeYes: options.yes }),
  });

  for (const outcome of outcomes) {
    const target = TARGETS[outcome.target];

    if (outcome.declined) {
      logger.info(`Skipped ${target.label} registration`);
      printManualRegistration(target, serverName);
      continue;
    }

    if (outcome.changed) {
      logger.success(`Registered "${serverName}" in ${outcome.relativeFile} for ${target.label}`);
    } else {
      logger.success(`Already registered as "${serverName}" in ${outcome.relativeFile}`);
    }

    if (target.mcp.note) {
      logger.info(target.mcp.note);
    }
  }
}

export async function targetsInstallCommand(options: TargetsInstallOptions = {}): Promise<void> {
  const { config, project } = await loadContext(options.cwd);
  const targets = options.target?.length ? parseTargetIds(options.target) : config.targets;

  const results = await installTargets(targets, {
    root: project.root,
    serverName: config.mcp.serverName,
    cohort: config.targets,
    force: options.force,
  });

  for (const result of results) {
    logger.print(`${result.target.label}:`);
    reportInstructions({ target: result.target, part: result.instructions }, 'Installed');
    reportRoles({ target: result.target, part: result.roles }, 'Installed');
    logger.print();
  }

  if (options.mcp !== false) {
    await registerTargetsInteractively(project.root, targets, config.mcp.serverName, {
      yes: options.yes,
    });
  }
}