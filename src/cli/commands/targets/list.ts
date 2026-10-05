/**
 * `nextjs-harness targets list` — which coding agents this project is set up
 * for, which ones it looks like the team also uses, and what each one has.
 */
import { requireNextJsProject } from '../../nextjs/project.js';
import { loadConfig } from '../../../generators/config-generator/config.js';
import { logger } from '../../../logger.js';
import { inspectTargetRegistration } from '../../../generators/targets/mcp.js';
import { ALL_TARGETS, detectTargets } from '../../../generators/targets/registry.js';
import type { TargetId } from '../../../generators/targets/types.js';

export interface TargetListEntry {
  id: TargetId;
  label: string;
  /** Listed in `.nextjs-harness/config.json`. */
  enabled: boolean;
  /** The project shows signs of this tool being used. */
  detected: boolean;
  /** The documentation MCP server is registered for it. */
  registered: boolean;
  mcpConfigFile: string;
  summary: string;
}

export interface TargetListReport {
  targets: TargetListEntry[];
  serverName: string;
}

export async function collectTargets(cwd?: string): Promise<TargetListReport> {
  const project = await requireNextJsProject(cwd);
  const config = await loadConfig(project.root);
  const enabled = config?.targets ?? [];
  const serverName = config?.mcp.serverName ?? 'nextjs-docs';
  const detected = await detectTargets(project.root);

  const targets: TargetListEntry[] = [];
  for (const target of ALL_TARGETS) {
    const registration = await inspectTargetRegistration(project.root, target, serverName);
    targets.push({
      id: target.id,
      label: target.label,
      enabled: enabled.includes(target.id),
      detected: detected.includes(target.id),
      registered: registration.registered,
      mcpConfigFile: target.mcp.file,
      summary: target.summary,
    });
  }

  return { targets, serverName };
}

export interface TargetsListOptions {
  cwd?: string;
  json?: boolean;
}

export async function targetsListCommand(options: TargetsListOptions = {}): Promise<void> {
  const report = await collectTargets(options.cwd);

  if (options.json) {
    logger.print(JSON.stringify(report, null, 2));
    return;
  }

  const mark = (value: boolean): string => (value ? 'yes' : '—');
  logger.print(`${'Agent'.padEnd(12)} ${'Set up'.padEnd(8)} ${'Detected'.padEnd(10)} MCP`);

  for (const entry of report.targets) {
    logger.print(
      `${entry.id.padEnd(12)} ${mark(entry.enabled).padEnd(8)} ${mark(entry.detected).padEnd(10)} ` +
        mark(entry.registered),
    );
  }

  logger.print();
  for (const entry of report.targets) {
    logger.print(`${entry.label}`);
    logger.print(`  ${entry.summary}`);
  }

  const missing = report.targets.filter((entry) => entry.detected && !entry.enabled);
  if (missing.length > 0) {
    logger.print();
    logger.info(
      `Detected but not set up: ${missing.map((entry) => entry.id).join(', ')}`,
    );
    logger.print();
    logger.print('Run:');
    logger.print(`  nextjs-harness targets add ${missing.map((entry) => entry.id).join(' ')}`);
  }
}
