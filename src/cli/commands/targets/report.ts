/**
 * Shared reporting for anything that installs files for a coding agent.
 *
 * One vocabulary for all five targets, so "what did that just write?" reads the
 * same whichever agents a project uses — and so a preserved local edit is always
 * called out rather than looking like a silent no-op.
 */
import path from 'node:path';

import { logger } from '../../../logger.js';
import type { TargetPartOutcome } from '../../../generators/targets/install.js';
import { SHARED_ROLES_DIR } from '../../../generators/targets/instructions.js';
import { SKILL_NAME } from '../../../generators/skill/templates.js';
import { countByStatus, type FileOutcome, type TargetDefinition } from '../../../generators/targets/types.js';

export type Verb = 'Installed' | 'Updated';

/** Where a target's guidance lives, project-relative, for display. */
export function instructionsLocation(target: TargetDefinition): string {
  switch (target.instructions.kind) {
    case 'skill':
      return `.claude/skills/${SKILL_NAME}`;
    case 'rules':
    case 'block':
      return target.instructions.file;
  }
}

/** Where a target's roles live, project-relative, for display. */
export function rolesLocation(target: TargetDefinition): string {
  switch (target.roles.kind) {
    case 'claude-agents':
      return '.claude/agents';
    case 'opencode-agents':
      return '.opencode/agent';
    case 'gemini-commands':
      return '.gemini/commands/nextjs';
    case 'cursor-commands':
      return '.cursor/commands';
    case 'shared-docs':
      return SHARED_ROLES_DIR;
  }
}

function counted(files: readonly FileOutcome[]): string {
  const counts = countByStatus(files);
  return `${counts.added} new, ${counts.updated} updated, ${counts.unchanged} unchanged`;
}

/** "nextjs-expert.md" / "expert.toml" -> the role name a human recognises. */
function roleNames(files: readonly FileOutcome[]): string {
  return files
    .map((file) => path.basename(file.file).replace(/\.(md|mdc|toml)$/, ''))
    .sort()
    .join(', ');
}

function skippedFiles(files: readonly FileOutcome[]): FileOutcome[] {
  return files.filter((file) => file.status === 'skipped');
}

function writtenFiles(files: readonly FileOutcome[]): FileOutcome[] {
  return files.filter((file) => file.status === 'added' || file.status === 'updated');
}

function reportSkipped(files: readonly FileOutcome[]): void {
  const skipped = skippedFiles(files);
  if (skipped.length === 0) {
    return;
  }

  logger.warn(`Kept ${skipped.length} locally modified file(s):`);
  for (const file of skipped) {
    logger.print(`    ${file.file}`);
  }
  logger.print();
  logger.print('Re-run with --force to overwrite them.');
}

export function reportInstructions(outcome: TargetPartOutcome, verb: Verb): void {
  const { target, part } = outcome;
  // Claude Code's wording predates targets and stays as it was.
  const label = target.id === 'claude-code' ? 'Next.js Skill' : `Next.js instructions for ${target.label}`;
  const where = instructionsLocation(target);

  if (writtenFiles(part.files).length > 0) {
    logger.success(`${verb} ${label} in ${where} (${counted(part.files)})`);
  } else if (skippedFiles(part.files).length === 0) {
    logger.success(`${label} already current in ${where}`);
  }

  reportSkipped(part.files);
}

export function reportRoles(outcome: TargetPartOutcome, verb: Verb): void {
  const { target, part } = outcome;
  const label = target.id === 'claude-code' ? 'Next.js agents' : `Next.js roles for ${target.label}`;
  const where = rolesLocation(target);
  const written = writtenFiles(part.files);

  if (written.length > 0) {
    logger.success(`${verb} ${label} in ${where}: ${roleNames(written)}`);
  } else if (skippedFiles(part.files).length === 0) {
    logger.success(`${label} already current in ${where} (${part.files.length})`);
  }

  if (part.unsupported) {
    logger.info(
      `${target.label} has no subagents — the roles are installed as playbooks it can be asked to read.`,
    );
  }

  reportSkipped(part.files);
}