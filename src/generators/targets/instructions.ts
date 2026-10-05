/**
 * Installing the Next.js guidance for one coding agent.
 *
 * There is exactly one source of guidance — `src/templates/skill/nextjs/` —
 * and every target renders from it. That is the point: a team using Claude Code
 * and Cursor on the same repository must not end up with two versions of "how
 * we write Next.js here" that drift apart.
 *
 * The reference documents are bulky and identical for every target, so they are
 * installed once into `.nextjs-harness/instructions/references/` and linked
 * from each target's own instructions file. Claude Code is the exception: its
 * Skill format expects `references/` inside the Skill directory, and that
 * layout is what makes progressive disclosure work there.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HARNESS_DIR } from '../../cli/nextjs/project.js';
import {
  installTemplateSet,
  render,
  type TemplateInstallResult,
  type TemplateOutput,
} from '../template-installer.js';
import { installSkill } from '../skill/installer.js';
import { readTemplate, templateRoot } from '../skill/templates.js';
import { splitFrontMatter } from './frontmatter.js';
import { findBlock, installManagedBlock } from './managed-block.js';
import { AGENT_NAMES } from '../agent/installer.js';
import { TARGETS } from './registry.js';
import {
  TARGET_IDS,
  type FileOutcome,
  type TargetDefinition,
  type TargetId,
  type TargetPartResult,
} from './types.js';

/** Where target-agnostic material lives, project-relative and POSIX-style. */
export const SHARED_INSTRUCTIONS_DIR = `${HARNESS_DIR}/instructions`;
export const SHARED_REFERENCES_DIR = `${SHARED_INSTRUCTIONS_DIR}/references`;
export const SHARED_ROLES_DIR = `${SHARED_INSTRUCTIONS_DIR}/roles`;

const SKILL_ENTRY = 'SKILL.md';

/** Turns installer bookkeeping into the flat per-file view targets report. */
export function toOutcomes(result: TemplateInstallResult, prefix = ''): FileOutcome[] {
  const outcomes: FileOutcome[] = [];
  const add = (files: string[], status: FileOutcome['status']): void => {
    for (const file of files) {
      outcomes.push({ file: prefix ? `${prefix}/${file}` : file, status });
    }
  };

  add(result.added, 'added');
  add(result.updated, 'updated');
  add(result.unchanged, 'unchanged');
  add(result.skipped, 'skipped');

  return outcomes;
}

/** How one agent reaches the four roles, as a list item. */
function roleLocation(target: TargetDefinition): string {
  switch (target.roles.kind) {
    case 'opencode-agents':
      return '`.opencode/agent/` — subagents; delegate a whole task to one';
    case 'gemini-commands':
      return '`.gemini/commands/nextjs/` — `/nextjs:expert`, `/nextjs:code-reviewer`, `/nextjs:test-writer`, `/nextjs:planner`';
    case 'cursor-commands':
      return '`.cursor/commands/` — invoke the one matching the job';
    case 'shared-docs':
      return `\`${SHARED_ROLES_DIR}/\` — read the one matching the job before starting`;
    case 'claude-agents':
      return '`.claude/agents/` — subagents; delegate a whole task to one';
  }
}

/**
 * Describes how the four roles are reachable.
 *
 * Written per target rather than generically because the answer really is
 * different: OpenCode can delegate to a subagent, Codex can only be asked to
 * read a document first. With several agents sharing one file it becomes a
 * list, because the file is read by all of them.
 */
function rolesSection(targets: readonly TargetDefinition[]): string {
  const names = AGENT_NAMES.join('`, `');
  const intro =
    `Four Next.js playbooks — \`${names}\` — cover implementation, review, tests and planning.\n` +
    'Use the one matching the job in hand.\n';

  if (targets.length === 1) {
    return `## Roles\n\n${intro}\nInstalled in ${roleLocation(targets[0]!)}.\n`;
  }

  const list = targets.map((target) => `- **${target.label}**: ${roleLocation(target)}`).join('\n');
  return `## Roles\n\n${intro}\n${list}\n`;
}

/**
 * The guidance body as these agents should see it.
 *
 * `targets` is every agent that reads this particular file. Usually one — but
 * `AGENTS.md` is by design a file several tools read, so when a project is set
 * up for both Codex and OpenCode they get **one** block describing both, rather
 * than each overwriting the other's on every run.
 *
 * Three rewrites: reference links point at the shared directory, the MCP tools
 * are introduced by the server name the project actually registered, and the
 * roles section explains how each tool reaches them.
 */
export function instructionsBody(
  skillSource: string,
  targets: readonly TargetDefinition[],
  serverName: string,
): string {
  const { body } = splitFrontMatter(skillSource);
  const heading = /^#\s+(.+)\r?\n+/.exec(body);
  const title = heading?.[1] ?? 'Next.js Development';
  const rest = (heading ? body.slice(heading[0].length) : body)
    .replaceAll('references/', `${SHARED_REFERENCES_DIR}/`)
    .trim();

  const registrations = targets.map((target) => `\`${target.mcp.file}\``);
  const where =
    registrations.length === 1
      ? registrations[0]!
      : `${registrations.slice(0, -1).join(', ')} and ${registrations.at(-1)!}`;
  const labels = targets.map((target) => target.label).join(' / ');

  // Sentences are kept whole rather than hand-wrapped: the interpolated file
  // names and labels vary in length, and a fixed wrap would break mid-value.
  const preamble =
    'Conventions for writing Next.js code in this project, installed and kept current by `nextjs-harness`.\n\n' +
    `The Next.js manual for this project's exact version is served by the \`${serverName}\` MCP server, ` +
    `registered in ${where}. The tools named below are that server's — if they are unavailable, ` +
    `run \`nextjs-harness setup\` and restart ${labels}.\n`;

  const roles = rolesSection(targets);

  return [`# ${title}`, preamble.trim(), rest, roles.trim()]
    .filter((part) => part !== '')
    .join('\n\n')
    .concat('\n');
}

/** Cursor's `.mdc` rules carry their own front matter. */
function cursorRuleHeader(description: string): string {
  return ['---', `description: ${description}`, 'globs: **/*.{ts,tsx,js,jsx,mdx}', 'alwaysApply: false', '---', ''].join(
    '\n',
  );
}

export interface InstallInstructionsOptions {
  root: string;
  target: TargetDefinition;
  serverName: string;
  /** Manifest recording what this target owns. */
  manifestFile: string;
  /**
   * Every agent the project is set up for. Used to work out who else reads the
   * same instructions file, so a shared `AGENTS.md` describes all of them.
   */
  cohort?: readonly TargetId[];
  force?: boolean;
}

/**
 * The agents that read the same instructions file as this one, in registry
 * order so the rendered block is stable whatever order installation happens in.
 */
export function fileCohort(
  target: TargetDefinition,
  cohort: readonly TargetId[] | undefined,
): TargetDefinition[] {
  if (target.instructions.kind !== 'block' || !cohort) {
    return [target];
  }

  const file = target.instructions.file;
  const sharers = TARGET_IDS.filter((id) => cohort.includes(id))
    .map((id) => TARGETS[id])
    .filter((other) => other.instructions.kind === 'block' && other.instructions.file === file);

  return sharers.length > 0 ? sharers : [target];
}

/**
 * Installs the shared reference documents, which every non-Claude target links
 * to. Claude Code keeps its own copy inside the Skill directory.
 */
async function installSharedReferences(
  options: InstallInstructionsOptions,
): Promise<FileOutcome[]> {
  const result = await installTemplateSet({
    sourceDir: templateRoot(),
    targetDir: options.root,
    manifestFile: options.manifestFile,
    templateSet: `target:${options.target.id}`,
    replacements: { MCP_SERVER: options.serverName },
    transform: (relative, content): TemplateOutput | undefined =>
      relative.startsWith('references/')
        ? { path: `${SHARED_REFERENCES_DIR}/${path.basename(relative)}`, content }
        : undefined,
    force: options.force,
  });

  return toOutcomes(result);
}

/**
 * Whether this target's guidance is actually in place.
 *
 * For a block target, "the file exists" is not enough — the file belongs to the
 * project and may well exist without our block in it.
 */
export async function instructionsInstalled(
  root: string,
  target: TargetDefinition,
): Promise<boolean> {
  const file =
    target.instructions.kind === 'skill'
      ? path.join(root, '.claude', 'skills', 'nextjs', SKILL_ENTRY)
      : path.join(root, target.instructions.file);

  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return false;
  }

  return target.instructions.kind === 'block' ? findBlock(content) !== undefined : true;
}

export async function installInstructions(
  options: InstallInstructionsOptions,
): Promise<TargetPartResult> {
  const { target } = options;

  // Claude Code's Skill is self-contained and already has an installer.
  if (target.instructions.kind === 'skill') {
    const result = await installSkill({
      root: options.root,
      mcpServerName: options.serverName,
      force: options.force,
    });
    const prefix = path
      .relative(options.root, result.skillDir)
      .split(path.sep)
      .join('/');
    return { files: toOutcomes(result, prefix) };
  }

  const files = await installSharedReferences(options);

  if (target.instructions.kind === 'rules') {
    const file = target.instructions.file;
    const result = await installTemplateSet({
      sourceDir: templateRoot(),
      targetDir: options.root,
      manifestFile: options.manifestFile,
      templateSet: `target:${target.id}`,
      only: [SKILL_ENTRY],
      replacements: { MCP_SERVER: options.serverName },
      transform: (relative, content): TemplateOutput => ({
        path: file,
        content:
          cursorRuleHeader(splitFrontMatter(content).attributes.description ?? 'Next.js conventions') +
          instructionsBody(content, [target], options.serverName),
      }),
      force: options.force,
    });

    return { files: [...files, ...toOutcomes(result)] };
  }

  // A block inside a file the project owns, possibly shared with other agents.
  const source = await readTemplate(templateRoot(), SKILL_ENTRY);
  const outcome = await installManagedBlock({
    root: options.root,
    file: target.instructions.file,
    body: render(
      instructionsBody(source, fileCohort(target, options.cohort), options.serverName),
      { MCP_SERVER: options.serverName },
    ),
    manifestFile: options.manifestFile,
    templateSet: `target:${target.id}`,
    force: options.force,
  });

  return { files: [...files, outcome] };
}
