/**
 * Installs the Next.js Skill into `.claude/skills/nextjs/`.
 *
 * The idempotent, edit-preserving behaviour lives in the shared template
 * installer; this module just points it at the Skill templates.
 */
import path from 'node:path';

import {
  installTemplateSet,
  MANIFEST_FILE,
  type TemplateInstallResult,
} from '../template-installer.js';
import { SKILL_NAME, templateRoot } from './templates.js';

/** Retained name for the Skill-specific shape of the install result. */
export interface SkillInstallResult extends TemplateInstallResult {
  skillDir: string;
}

export function skillDirFor(root: string, skill: string = SKILL_NAME): string {
  return path.join(root, '.claude', 'skills', skill);
}

export interface InstallSkillOptions {
  root: string;
  skill?: string;
  /** MCP server name, substituted into the Skill's tool references. */
  mcpServerName?: string;
  /** Overwrite locally modified files. */
  force?: boolean;
}

export async function installSkill(options: InstallSkillOptions): Promise<SkillInstallResult> {
  const skill = options.skill ?? SKILL_NAME;
  const skillDir = skillDirFor(options.root, skill);

  const result = await installTemplateSet({
    sourceDir: templateRoot(skill),
    targetDir: skillDir,
    manifestFile: path.join(skillDir, MANIFEST_FILE),
    templateSet: `skill:${skill}`,
    replacements: { MCP_SERVER: options.mcpServerName ?? 'nextjs-docs' },
    force: options.force,
  });

  return { ...result, skillDir };
}
