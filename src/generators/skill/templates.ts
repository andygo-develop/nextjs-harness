/**
 * Locating the bundled Skill templates.
 *
 * The templates ship in the npm package (see `files` in package.json) and are
 * resolved relative to the installed module, so the CLI works the same whether
 * it is run from a global install, a local node_modules, or npx.
 */
import { listTemplateFiles, packageTemplateDir, readTemplate } from '../template-installer.js';

export const SKILL_NAME = 'nextjs';

/** Absolute path to `src/templates/skill/<name>` inside the installed package. */
export function templateRoot(skill: string = SKILL_NAME): string {
  return packageTemplateDir('skill', skill);
}

export { listTemplateFiles, readTemplate };
