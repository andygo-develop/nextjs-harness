#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Commands are hierarchical (`manuals sync`, `skill install`, `mcp start`) so
 * the surface can grow without flattening into an unreadable list. The flat
 * legacy names are deliberately not part of the public API.
 */
import { Command } from 'commander';

import { isHarnessError } from '../errors.js';
import { logger } from '../logger.js';
import { packageVersion } from '../package-version.js';
import { parseTargetIds } from '../generators/targets/registry.js';
import { agentInstallCommand } from './commands/agent/install.js';
import { agentUpdateCommand } from './commands/agent/update.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { indexCommand } from './commands/manuals/index.js';
import { searchCommand } from './commands/manuals/search.js';
import { statusCommand } from './commands/manuals/status.js';
import { syncCommand } from './commands/manuals/sync.js';
import { updateCommand } from './commands/manuals/update.js';
import { versionsCommand } from './commands/manuals/versions.js';
import { mcpStartCommand } from './commands/mcp/start.js';
import { mcpStatusCommand } from './commands/mcp/status.js';
import { setupCommand } from './commands/setup.js';
import { targetsAddCommand } from './commands/targets/add.js';
import { targetsInstallCommand } from './commands/targets/install.js';
import { targetsListCommand } from './commands/targets/list.js';
import { targetsRemoveCommand } from './commands/targets/remove.js';
import { specsIndexCommand } from './commands/specs/index.js';
import { specsSearchCommand } from './commands/specs/search.js';
import { specsStatusCommand } from './commands/specs/status.js';
import { skillInstallCommand } from './commands/skill/install.js';
import { skillUpdateCommand } from './commands/skill/update.js';

const program = new Command();

/** Collects a repeatable `--target` flag, which also accepts comma-separated ids. */
const collectTargets = (value: string, previous: string[] = []): string[] => [...previous, value];

program
  .name('nextjs-harness')
  .description('Local AI development harness for Next.js projects')
  .version(packageVersion(), '-V, --version', 'Show the harness version')
  .option('--verbose', 'Show diagnostic output and stack traces', false)
  .hook('preAction', (thisCommand) => {
    logger.setVerbose(Boolean(thisCommand.opts().verbose));
  });

program
  .command('init')
  .description('Detect the Next.js project and create .nextjs-harness/')
  .option(
    '--target <agent>',
    'Coding agent to set up for (repeatable; default: auto-detected)',
    collectTargets,
  )
  .action(async (options: { target?: string[] }) => {
    await initCommand({ targets: options.target ? parseTargetIds(options.target) : undefined });
  });

program
  .command('setup')
  .description('One-command setup: detect, configure, install agent files, sync and index manuals')
  .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
  .option('--no-mcp', 'Skip MCP registration')
  .option('--no-manuals', 'Skip downloading and indexing the manuals')
  .option(
    '--target <agent>',
    'Coding agent to set up for (repeatable; default: the configured agents)',
    collectTargets,
  )
  .action(async (options: { yes: boolean; mcp: boolean; manuals: boolean; target?: string[] }) => {
    await setupCommand({
      yes: options.yes,
      mcp: options.mcp,
      manuals: options.manuals,
      target: options.target,
    });
  });

program
  .command('doctor')
  .description('Check that the harness is correctly set up and the MCP tools work')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options: { json: boolean }) => {
    await doctorCommand({ json: options.json });
  });

const manuals = program
  .command('manuals')
  .description('Synchronize, index and search the Next.js manuals');

manuals
  .command('sync')
  .description('Download the official Next.js documentation for this project')
  .option('--force', 'Re-download even if already up to date', false)
  .action(async (options: { force: boolean }) => {
    await syncCommand({ force: options.force });
  });

manuals
  .command('index')
  .description('Build the search index from the synchronized documentation')
  .option('--rebuild', 'Discard and rebuild the index from scratch', false)
  .action(async (options: { rebuild: boolean }) => {
    await indexCommand({ rebuild: options.rebuild });
  });

manuals
  .command('search <query...>')
  .description('Search the Next.js documentation')
  .option('-l, --limit <n>', 'Maximum number of results', (value) => Number.parseInt(value, 10), 5)
  .option('--full', 'Print whole documents instead of excerpts', false)
  .option('--version <version>', 'Search a specific Next.js version (must be synchronized)')
  .action(async (query: string[], options: { limit: number; full: boolean; version?: string }) => {
    await searchCommand(query.join(' '), {
      limit: options.limit,
      full: options.full,
      version: options.version,
    });
  });

manuals
  .command('update')
  .description('Synchronize the manuals and update the index (the usual command)')
  .option('--force', 'Re-download and rebuild the index from scratch', false)
  .action(async (options: { force: boolean }) => {
    await updateCommand({ force: options.force });
  });

manuals
  .command('status')
  .description('Show what is synchronized and indexed')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options: { json: boolean }) => {
    await statusCommand({ json: options.json });
  });

manuals
  .command('versions')
  .description('List Next.js documentation lines and their local status')
  .action(async () => {
    await versionsCommand();
  });

const targets = program
  .command('targets')
  .description('Manage which coding agents this project is set up for');

targets
  .command('list')
  .description('List supported coding agents and whether they are set up')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options: { json: boolean }) => {
    await targetsListCommand({ json: options.json });
  });

targets
  .command('add <agent...>')
  .description('Set this project up for another coding agent and install its files')
  .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
  .option('--no-mcp', 'Skip MCP registration')
  .option('--force', 'Overwrite locally modified files', false)
  .action(async (agents: string[], options: { yes: boolean; mcp: boolean; force: boolean }) => {
    await targetsAddCommand(agents, { yes: options.yes, mcp: options.mcp, force: options.force });
  });

targets
  .command('remove <agent...>')
  .description('Stop maintaining files for a coding agent (nothing is deleted)')
  .action(async (agents: string[]) => {
    await targetsRemoveCommand(agents);
  });

targets
  .command('install')
  .description('Install guidance, roles and MCP registration for every configured agent')
  .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
  .option('--no-mcp', 'Skip MCP registration')
  .option('--force', 'Overwrite locally modified files', false)
  .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
  .action(
    async (options: { yes: boolean; mcp: boolean; force: boolean; target?: string[] }) => {
      await targetsInstallCommand({
        yes: options.yes,
        mcp: options.mcp,
        force: options.force,
        target: options.target,
      });
    },
  );

const skill = program
  .command('skill')
  .description('Manage the Next.js guidance installed for each coding agent');

skill
  .command('install')
  .description('Install the Next.js guidance for every configured coding agent')
  .option('--force', 'Overwrite locally modified files', false)
  .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
  .action(async (options: { force: boolean; target?: string[] }) => {
    await skillInstallCommand({ force: options.force, target: options.target });
  });

skill
  .command('update')
  .description('Update the installed guidance, preserving local edits')
  .option('--force', 'Overwrite locally modified files', false)
  .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
  .action(async (options: { force: boolean; target?: string[] }) => {
    await skillUpdateCommand({ force: options.force, target: options.target });
  });

const specs = program
  .command('specs')
  .description("Index and search this project's own specs and documentation (optional)");

specs
  .command('index')
  .description("Index the project's spec files and enable project spec search")
  .option('--rebuild', 'Discard and rebuild the spec index from scratch', false)
  .action(async (options: { rebuild: boolean }) => {
    await specsIndexCommand({ rebuild: options.rebuild });
  });

specs
  .command('search <query...>')
  .description("Search this project's own specs")
  .option('-l, --limit <n>', 'Maximum number of results', (value) => Number.parseInt(value, 10), 5)
  .option('--full', 'Print whole documents instead of excerpts', false)
  .action(async (query: string[], options: { limit: number; full: boolean }) => {
    await specsSearchCommand(query.join(' '), { limit: options.limit, full: options.full });
  });

specs
  .command('status')
  .description('Show whether project spec search is enabled and current')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options: { json: boolean }) => {
    await specsStatusCommand({ json: options.json });
  });

const agent = program
  .command('agent')
  .description('Manage the four Next.js roles installed for each coding agent');

agent
  .command('install')
  .description('Install the Next.js roles for every configured coding agent')
  .option('--force', 'Overwrite locally modified role files', false)
  .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
  .action(async (options: { force: boolean; target?: string[] }) => {
    await agentInstallCommand({ force: options.force, target: options.target });
  });

agent
  .command('update')
  .description('Update the installed roles, preserving local edits')
  .option('--force', 'Overwrite locally modified role files', false)
  .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
  .action(async (options: { force: boolean; target?: string[] }) => {
    await agentUpdateCommand({ force: options.force, target: options.target });
  });

const mcp = program.command('mcp').description('Manage the Next.js documentation MCP server');

mcp
  .command('start')
  .description('Run the documentation MCP server on stdio (usually launched by Claude Code)')
  .action(async () => {
    await mcpStartCommand();
  });

mcp
  .command('status')
  .description('Show MCP registration and documentation readiness')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options: { json: boolean }) => {
    await mcpStatusCommand({ json: options.json });
  });

/**
 * Prints expected failures as a message plus an actionable hint, with no stack
 * trace unless --verbose. Unexpected errors always show their stack, because
 * those are bugs.
 */
function reportError(error: unknown): number {
  if (isHarnessError(error)) {
    logger.error(error.message);
    if (error.hint) {
      process.stderr.write(`\n${error.hint}\n`);
    }
    if (logger.isVerbose() && error.stack) {
      process.stderr.write(`\n${error.stack}\n`);
    }
    return error.exitCode;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(err.message);
  process.stderr.write(`\n${err.stack ?? ''}\n`);
  return 1;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    process.exitCode = reportError(error);
  }
}

await main();
