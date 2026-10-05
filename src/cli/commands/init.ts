/**
 * `nextjs-harness init` — prepare the project without downloading anything.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { harnessPaths, requireNextJsProject } from '../nextjs/project.js';
import { ensureConfig } from '../../generators/config-generator/config.js';
import { logger } from '../../logger.js';
import { detectTargets, TARGETS } from '../../generators/targets/registry.js';
import type { TargetId } from '../../generators/targets/types.js';

export interface InitResult {
  root: string;
  created: boolean;
  versionChanged: boolean;
  version: string;
  docsLine: string;
  /** Coding agents this project is configured for. */
  targets: TargetId[];
  /** Whether those were detected from the project rather than asked for. */
  targetsDetected: boolean;
}

export interface InitOptions {
  cwd?: string;
  /** Coding agents to record. Only applied when the config is being created. */
  targets?: readonly TargetId[];
}

export async function runInit(options: InitOptions | string = {}): Promise<InitResult> {
  // Historically this took a cwd string; both forms are still accepted.
  const resolved: InitOptions = typeof options === 'string' ? { cwd: options } : options;
  const project = await requireNextJsProject(resolved.cwd);
  const paths = harnessPaths(project.root);

  // mkdir -p is already idempotent; running init twice is a no-op here.
  for (const dir of [paths.harnessDir, paths.manualsDir, paths.indexDir, paths.cacheDir]) {
    await mkdir(dir, { recursive: true });
  }

  /**
   * Detection only ever informs a *new* config. Once `targets` is recorded it
   * is the team's decision — adding `.cursor/` to a repository must not silently
   * start writing Cursor files on the next unrelated command.
   */
  const detected = resolved.targets?.length ? [] : await detectTargets(project.root);
  const targets = resolved.targets?.length ? [...resolved.targets] : detected;

  const { config, created, versionChanged } = await ensureConfig(project.root, project.version, {
    targets,
  });

  return {
    root: project.root,
    created,
    versionChanged,
    version: project.version.version,
    docsLine: project.version.docsLine,
    targets: config.targets,
    targetsDetected: created && !resolved.targets?.length && detected.length > 0,
  };
}

export async function initCommand(options: InitOptions | string = {}): Promise<void> {
  const result = await runInit(options);
  const relative = path.relative(process.cwd(), result.root) || '.';

  logger.success(`Next.js ${result.version} project detected in ${relative}`);

  if (result.created) {
    logger.success('Created .nextjs-harness/ with config.json, manuals/, index/ and cache/');
  } else if (result.versionChanged) {
    logger.success(`Updated configuration — Next.js version is now ${result.version}`);
  } else {
    logger.info('Already initialised — configuration left unchanged');
  }

  logger.print();
  logger.print(`Documentation line: nextjs-${result.docsLine}`);
  logger.print(
    `Coding agents:      ${result.targets.map((id) => TARGETS[id].label).join(', ')}` +
      (result.targetsDetected ? ' (detected)' : ''),
  );
  logger.print();
  logger.print('Next:');
  logger.print('  nextjs-harness setup            full setup (skill + manuals + index + MCP)');
  logger.print('  nextjs-harness targets list     coding agents this project is set up for');
  logger.print('  nextjs-harness manuals update   download and index the manuals only');
}
