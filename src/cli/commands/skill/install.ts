/**
 * `nextjs-harness skill install` / `skill update`.
 *
 * Both call the same installer — "update" is just the friendlier name for
 * re-running it, and both preserve local edits unless --force is given.
 *
 * "Skill" is Claude Code's word for it. The same guidance is installed for
 * every coding agent the project is configured for, in whatever form that agent
 * reads: a Cursor rule, a block in AGENTS.md, a block in GEMINI.md.
 */
import { requireNextJsProject } from '../../nextjs/project.js';
import { loadConfig } from '../../../generators/config-generator/config.js';
import { installInstructionsFor, type TargetPartOutcome } from '../../../generators/targets/install.js';
import { parseTargetIds } from '../../../generators/targets/registry.js';
import { reportInstructions, type Verb } from '../targets/report.js';

export interface SkillCommandOptions {
  cwd?: string;
  force?: boolean;
  /** Restrict to these agents instead of everything the config lists. */
  target?: readonly string[];
}

export async function runSkillInstall(
  options: SkillCommandOptions = {},
): Promise<TargetPartOutcome[]> {
  const project = await requireNextJsProject(options.cwd);
  const config = await loadConfig(project.root);

  // Falls back to Claude Code before `init` has run, which is what this command
  // did when Claude Code was the only thing it could install for.
  const targets = options.target?.length
    ? parseTargetIds(options.target)
    : (config?.targets ?? ['claude-code']);

  return installInstructionsFor(targets, {
    root: project.root,
    serverName: config?.mcp.serverName ?? 'nextjs-docs',
    // Shared files describe every configured agent, not just the ones this run
    // touches, so `--target` cannot rewrite AGENTS.md as if the others were gone.
    cohort: config?.targets,
    force: options.force,
  });
}

export function reportSkillResult(outcomes: readonly TargetPartOutcome[], verb: Verb): void {
  for (const outcome of outcomes) {
    reportInstructions(outcome, verb);
  }
}

export async function skillInstallCommand(options: SkillCommandOptions = {}): Promise<void> {
  reportSkillResult(await runSkillInstall(options), 'Installed');
}
