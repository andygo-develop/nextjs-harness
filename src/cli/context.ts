/**
 * Shared command setup: locate the project, load its config, resolve paths.
 */
import { harnessPaths, requireNextJsProject, type NextJsProject, type HarnessPaths } from './nextjs/project.js';
import { loadConfig, reconcileConfig, requireConfig } from '../generators/config-generator/config.js';
import type { HarnessConfig } from '../generators/config-generator/schema.js';

export interface CommandContext {
  project: NextJsProject;
  config: HarnessConfig;
  paths: HarnessPaths;
}

/**
 * Loads a fully initialised project, or throws "run setup first".
 *
 * The stored config is reconciled against the project's current Next.js
 * version, so an upgraded project can never keep using its old corpus.
 */
export async function loadContext(cwd: string = process.cwd()): Promise<CommandContext> {
  const project = await requireNextJsProject(cwd);
  const stored = await requireConfig(project.root);
  const config = await reconcileConfig(project.root, project.version, stored);
  return { project, config, paths: harnessPaths(project.root) };
}

/** Like loadContext but tolerates a missing config (returns undefined for it). */
export async function loadOptionalContext(
  cwd: string = process.cwd(),
): Promise<{ project: NextJsProject; config?: HarnessConfig; paths: HarnessPaths }> {
  const project = await requireNextJsProject(cwd);
  const config = await loadConfig(project.root);
  return { project, config, paths: harnessPaths(project.root) };
}
