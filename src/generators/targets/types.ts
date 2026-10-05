/**
 * What a "target" is: one coding agent the harness can be set up for.
 *
 * The harness gives an agent three things — instructions (how to write Next.js
 * code), roles (task-shaped playbooks), and the documentation MCP server. Every
 * supported agent accepts all three, but each in its own file layout and
 * dialect, so a target is a *description of those conventions* rather than a
 * separate implementation. Adding an agent means adding a definition here and
 * teaching the three writers about its style — not forking the installer.
 *
 * Deliberately data, not behaviour: the same template sources are rendered for
 * every target, so guidance can never drift between the agents a team uses.
 */

export const TARGET_IDS = ['claude-code', 'cursor', 'codex', 'gemini', 'opencode'] as const;

export type TargetId = (typeof TARGET_IDS)[number];

/**
 * How a target's MCP configuration file is shaped.
 *
 * - `mcpServers` — a JSON object keyed by server name, holding `command`/`args`.
 *   Claude Code, Cursor and Gemini CLI all use this, at different paths.
 * - `opencode`   — JSON, but servers live under `mcp` and take a single
 *   `command` argv array plus `type: "local"`.
 * - `codex-toml` — a TOML `[mcp_servers.<name>]` table.
 */
export type McpStyle = 'mcpServers' | 'opencode' | 'codex-toml';

export interface TargetMcp {
  /** Project-relative configuration file. */
  file: string;
  style: McpStyle;
  /** Extra guidance printed after registering, when the tool needs it. */
  note?: string;
}

/**
 * Where the Next.js guidance goes.
 *
 * - `skill` — Claude Code's Skill directory, installed whole.
 * - `rules` — a file the harness owns outright, in the tool's rules directory.
 * - `block` — a marked-off block inside a file the *project* owns (AGENTS.md,
 *   GEMINI.md). Merged in, never written over the rest of the file.
 */
export type InstructionsStyle =
  | { kind: 'skill' }
  | { kind: 'rules'; file: string }
  | { kind: 'block'; file: string };

/**
 * How the four Next.js roles are expressed.
 *
 * Only Claude Code and OpenCode have real subagents. The rest get the closest
 * native equivalent — a slash command, or plain playbook documents the agent is
 * pointed at — rather than a fabricated format that would silently do nothing.
 */
export type RolesStyle =
  | { kind: 'claude-agents' }
  | { kind: 'opencode-agents' }
  | { kind: 'gemini-commands' }
  | { kind: 'cursor-commands' }
  | { kind: 'shared-docs' };

export interface TargetDefinition {
  id: TargetId;
  label: string;
  instructions: InstructionsStyle;
  roles: RolesStyle;
  mcp: TargetMcp;
  /**
   * Project-relative paths whose presence means this tool is probably in use.
   * Used to propose targets at `init`; never to enable one behind the user's
   * back after the config exists.
   */
  markers: readonly string[];
  /** One line for `targets list`, describing what installing this writes. */
  summary: string;
}

/** What happened to one file, normalised across all three writers. */
export interface FileOutcome {
  /** Project-relative path. */
  file: string;
  status: 'added' | 'updated' | 'unchanged' | 'skipped';
}

export interface TargetPartResult {
  files: FileOutcome[];
  /**
   * The tool has no equivalent for this part, so nothing was written. Reported
   * rather than hidden — a missing reviewer subagent is worth knowing about.
   */
  unsupported?: boolean;
}

export function countByStatus(files: readonly FileOutcome[]): Record<FileOutcome['status'], number> {
  const counts = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const file of files) {
    counts[file.status] += 1;
  }
  return counts;
}

/** True when the writer had to preserve at least one locally edited file. */
export function hasSkipped(files: readonly FileOutcome[]): boolean {
  return files.some((file) => file.status === 'skipped');
}

/** True when nothing was written because everything already matched. */
export function isCurrent(files: readonly FileOutcome[]): boolean {
  return files.length > 0 && files.every((file) => file.status === 'unchanged');
}