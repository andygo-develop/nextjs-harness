/**
 * The supported coding agents, and how to recognise one in a project.
 *
 * Each entry records only that tool's *conventions* — where its rules live,
 * whether it has subagents, which file holds its MCP servers. The content
 * installed into them comes from the same templates for every target.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError } from '../../errors.js';
import { TARGET_IDS, type TargetDefinition, type TargetId } from './types.js';

export const TARGETS: Record<TargetId, TargetDefinition> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    instructions: { kind: 'skill' },
    roles: { kind: 'claude-agents' },
    mcp: { file: '.mcp.json', style: 'mcpServers' },
    markers: ['.claude', '.mcp.json', 'CLAUDE.md'],
    summary: 'Skill in .claude/skills/, subagents in .claude/agents/, MCP in .mcp.json',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    instructions: { kind: 'rules', file: '.cursor/rules/nextjs.mdc' },
    roles: { kind: 'cursor-commands' },
    mcp: { file: '.cursor/mcp.json', style: 'mcpServers' },
    markers: ['.cursor'],
    summary: 'Rule in .cursor/rules/, commands in .cursor/commands/, MCP in .cursor/mcp.json',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    instructions: { kind: 'block', file: 'AGENTS.md' },
    // Codex has no subagent concept, so the roles ship as playbook documents
    // that AGENTS.md points at. Inert on their own, but readable on request.
    roles: { kind: 'shared-docs' },
    mcp: {
      file: '.codex/config.toml',
      style: 'codex-toml',
      note:
        'Codex also reads ~/.codex/config.toml. If it does not pick the project file up, ' +
        'copy the [mcp_servers] block there.',
    },
    markers: ['.codex', 'AGENTS.md'],
    summary: 'Block in AGENTS.md, role playbooks in .nextjs-harness/, MCP in .codex/config.toml',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    instructions: { kind: 'block', file: 'GEMINI.md' },
    roles: { kind: 'gemini-commands' },
    mcp: { file: '.gemini/settings.json', style: 'mcpServers' },
    markers: ['.gemini', 'GEMINI.md'],
    summary: 'Block in GEMINI.md, commands in .gemini/commands/, MCP in .gemini/settings.json',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    instructions: { kind: 'block', file: 'AGENTS.md' },
    roles: { kind: 'opencode-agents' },
    mcp: { file: 'opencode.json', style: 'opencode' },
    markers: ['opencode.json', 'opencode.jsonc', '.opencode'],
    summary: 'Block in AGENTS.md, subagents in .opencode/agent/, MCP in opencode.json',
  },
};

export const ALL_TARGETS: readonly TargetDefinition[] = TARGET_IDS.map((id) => TARGETS[id]);

export function isTargetId(value: string): value is TargetId {
  return (TARGET_IDS as readonly string[]).includes(value);
}

/** Resolves an id, or throws listing the ids that do exist. */
export function requireTarget(id: string): TargetDefinition {
  if (!isTargetId(id)) {
    throw new HarnessError(`Unknown coding agent "${id}".`, {
      hint:
        `Supported agents:\n\n${ALL_TARGETS.map((target) => `  ${target.id.padEnd(12)} ${target.label}`).join('\n')}` +
        '\n\nRun:\n\n  nextjs-harness targets list',
    });
  }
  return TARGETS[id];
}

/**
 * Parses `--target` values, accepting repeated flags and comma-separated lists,
 * and preserving the order the user gave while dropping duplicates.
 */
export function parseTargetIds(values: readonly string[]): TargetId[] {
  const ids: TargetId[] = [];
  for (const value of values.flatMap((entry) => entry.split(','))) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const target = requireTarget(trimmed);
    if (!ids.includes(target.id)) {
      ids.push(target.id);
    }
  }
  return ids;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which agents this project already shows signs of using.
 *
 * Only consulted when writing a fresh config: once `targets` is recorded, it is
 * the user's decision and detection must not quietly add to it. Note that
 * `AGENTS.md` is shared by several tools, so it is a weak signal for Codex and
 * a strong one for nothing.
 */
export async function detectTargets(root: string): Promise<TargetId[]> {
  const detected: TargetId[] = [];

  for (const target of ALL_TARGETS) {
    const found = await Promise.all(
      target.markers.map((marker) => exists(path.join(root, marker))),
    );
    if (found.some(Boolean)) {
      detected.push(target.id);
    }
  }

  return detected;
}