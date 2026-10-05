/**
 * Installing the four Next.js roles for one coding agent.
 *
 * The roles — expert, code reviewer, test writer, planner — are written once as
 * Claude Code subagents in `src/templates/agent/` and re-expressed here for
 * whatever the target actually supports. Only Claude Code and OpenCode have
 * real subagents; the rest get commands or playbook documents.
 *
 * Two details are not cosmetic:
 *
 *   - **Tool names.** Claude Code namespaces MCP tools as `mcp__<server>__<tool>`;
 *     other clients expose them plainly. A role telling Gemini CLI to call
 *     `mcp__nextjs-docs__search_nextjs_manual` would simply never look
 *     anything up, so the prefix is stripped for those targets.
 *   - **Permissions.** The reviewer must not be able to edit the code it is
 *     reviewing. That restriction is expressed in the template's Claude `tools:`
 *     line and translated into each target's own permission vocabulary rather
 *     than being dropped when the syntax differs.
 */
import path from 'node:path';

import { agentsDirFor, installAgents } from '../agent/installer.js';
import {
  installTemplateSet,
  packageTemplateDir,
  type TemplateOutput,
} from '../template-installer.js';
import { splitFrontMatter, toolList } from './frontmatter.js';
import { SHARED_ROLES_DIR, toOutcomes } from './instructions.js';
import type { TargetDefinition, TargetPartResult } from './types.js';

/** `mcp__{{MCP_SERVER}}__search_nextjs_manual` -> `search_nextjs_manual`. */
function plainToolNames(content: string): string {
  return content.replaceAll('mcp__{{MCP_SERVER}}__', '');
}

/** Escapes a TOML basic string; `\` matters because class names are full of it. */
export function tomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * Maps a Claude `tools:` list onto OpenCode's permission booleans.
 *
 * A template with no `tools:` line is unrestricted by design (the expert writes
 * code), so it gets full access. Anything listed is an allow-list, and what is
 * absent is denied — which is what keeps the reviewer read-only.
 */
export function opencodeTools(tools: string[] | undefined): Record<string, boolean> {
  if (!tools) {
    return { read: true, grep: true, glob: true, bash: true, write: true, edit: true };
  }

  const has = (name: string): boolean => tools.includes(name);
  return {
    read: has('Read'),
    grep: has('Grep'),
    glob: has('Glob'),
    bash: has('Bash'),
    write: has('Write'),
    edit: has('Edit'),
  };
}

/** `nextjs-code-reviewer` -> `code-reviewer`, for `/nextjs:code-reviewer`. */
function shortName(name: string): string {
  return name.replace(/^nextjs-/, '');
}

function opencodeAgent(name: string, source: string): string {
  const { attributes, body } = splitFrontMatter(source);
  const tools = opencodeTools(toolList(attributes));
  const permissions = Object.entries(tools)
    .map(([tool, allowed]) => `  ${tool}: ${allowed}`)
    .join('\n');

  return [
    '---',
    `description: ${attributes.description ?? name}`,
    'mode: subagent',
    'tools:',
    permissions,
    '---',
    '',
    plainToolNames(body).trimEnd(),
    '',
  ].join('\n');
}

function geminiCommand(name: string, source: string): string {
  const { attributes, body } = splitFrontMatter(source);
  const prompt = plainToolNames(body).trimEnd();

  return [
    `description = "${tomlString(attributes.description ?? name)}"`,
    'prompt = """',
    tomlString(prompt),
    '"""',
    '',
  ].join('\n');
}

function markdownRole(name: string, source: string, note: string): string {
  const { attributes, body } = splitFrontMatter(source);

  return [
    `# ${name}`,
    '',
    attributes.description ?? '',
    '',
    note,
    '',
    plainToolNames(body).trimEnd(),
    '',
  ].join('\n');
}

/** Where each role file lands, and what it says, for a given target. */
function roleTransform(target: TargetDefinition): (relative: string, content: string) => TemplateOutput | undefined {
  return (relative, content) => {
    const name = path.basename(relative, '.md');

    switch (target.roles.kind) {
      case 'opencode-agents':
        return { path: `.opencode/agent/${name}.md`, content: opencodeAgent(name, content) };
      case 'gemini-commands':
        return {
          path: `.gemini/commands/nextjs/${shortName(name)}.toml`,
          content: geminiCommand(name, content),
        };
      case 'cursor-commands':
        return {
          path: `.cursor/commands/${name}.md`,
          content: markdownRole(
            name,
            content,
            'Follow this playbook for the task at hand.',
          ),
        };
      case 'shared-docs':
        return {
          path: `${SHARED_ROLES_DIR}/${name}.md`,
          content: markdownRole(
            name,
            content,
            'Read this before starting that kind of Next.js work, and follow it.',
          ),
        };
      case 'claude-agents':
        return { path: relative, content };
    }
  };
}

export interface InstallRolesOptions {
  root: string;
  target: TargetDefinition;
  serverName: string;
  manifestFile: string;
  force?: boolean;
}

export async function installRoles(options: InstallRolesOptions): Promise<TargetPartResult> {
  const { target } = options;

  // Claude Code has its own installer and its own long-standing manifest.
  if (target.roles.kind === 'claude-agents') {
    const result = await installAgents({
      root: options.root,
      mcpServerName: options.serverName,
      force: options.force,
    });
    const prefix = path.relative(options.root, agentsDirFor(options.root)).split(path.sep).join('/');
    return { files: toOutcomes(result, prefix) };
  }

  const result = await installTemplateSet({
    sourceDir: packageTemplateDir('agent'),
    targetDir: options.root,
    manifestFile: options.manifestFile,
    templateSet: `target:${target.id}`,
    replacements: { MCP_SERVER: options.serverName },
    transform: roleTransform(target),
    force: options.force,
  });

  return {
    files: toOutcomes(result),
    // Codex has no subagents or commands; the playbooks are documents it must
    // be told to read. Reported so the difference is never a silent surprise.
    unsupported: target.roles.kind === 'shared-docs',
  };
}