/**
 * Registering the documentation server with each coding agent.
 *
 * Three dialects, one policy: merge into whatever is already there, never
 * rewrite or remove another server's entry, and leave an existing entry for our
 * own server alone — a developer who customised it meant to.
 *
 * The TOML path is append-only for the same reason. Rewriting a config file we
 * cannot fully parse would risk losing settings we never understood, so an
 * existing `[mcp_servers.<name>]` table is detected and left as it is, and a
 * missing one is appended as a new table at the end of the file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError } from '../../errors.js';
import { MCP_ARGS, MCP_COMMAND, mcpCommandLine } from '../mcp-entry.js';
import { TARGETS } from './registry.js';
import type { McpStyle, TargetDefinition, TargetId } from './types.js';

export interface TargetRegistrationState {
  target: TargetId;
  label: string;
  /** Absolute path to the tool's MCP configuration file. */
  configFile: string;
  /** Project-relative path, for display. */
  relativeFile: string;
  fileExists: boolean;
  /** Our server name is present. */
  registered: boolean;
  /** Present and pointing at this package's `mcp start`. */
  current: boolean;
  /** Other servers already configured, left untouched. */
  otherServers: string[];
}

export interface TargetRegisterResult extends TargetRegistrationState {
  changed: boolean;
}

/* ------------------------------------------------------------------ JSON -- */

interface JsonServers {
  [key: string]: unknown;
}

/** The `command`/`args` entry shape used by Claude Code, Cursor and Gemini CLI. */
export function commandArgsEntry(): { command: string; args: string[] } {
  return { command: MCP_COMMAND, args: [...MCP_ARGS] };
}

/** OpenCode takes the whole launch line as one array. */
export function opencodeEntry(): { type: string; command: string[]; enabled: boolean } {
  return { type: 'local', command: mcpCommandLine(), enabled: true };
}

function serversKey(style: McpStyle): string {
  return style === 'opencode' ? 'mcp' : 'mcpServers';
}

function desiredJsonEntry(style: McpStyle): Record<string, unknown> {
  return style === 'opencode' ? opencodeEntry() : commandArgsEntry();
}

/**
 * Whether an existing entry already launches this package.
 *
 * Compared field by field rather than by deep equality, so a developer who
 * added `env` or `enabled` to our entry is not told it is out of date.
 */
function isSameJsonEntry(entry: unknown, style: McpStyle): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;

  if (style === 'opencode') {
    return JSON.stringify(record.command) === JSON.stringify(mcpCommandLine());
  }

  return (
    record.command === MCP_COMMAND && JSON.stringify(record.args ?? []) === JSON.stringify(MCP_ARGS)
  );
}

async function readJsonConfig(configFile: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(configFile, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new HarnessError(`${path.basename(configFile)} exists but is not valid JSON.`, {
      hint: `Fix or remove it, then re-run:\n\n  ${configFile}`,
      cause,
    });
  }
}

/* ------------------------------------------------------------------ TOML -- */

/** TOML bare keys allow letters, digits, `_` and `-`; anything else is quoted. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function codexTable(serverName: string): string {
  const args = MCP_ARGS.map((arg) => JSON.stringify(arg)).join(', ');
  return (
    `[mcp_servers.${tomlKey(serverName)}]\n` +
    `command = ${JSON.stringify(MCP_COMMAND)}\n` +
    `args = [${args}]\n`
  );
}

/** Matches `[mcp_servers.name]` or `[mcp_servers."name"]` at the start of a line. */
function codexTablePattern(serverName: string): RegExp {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|${escaped})\\]`, 'm');
}

/** Every `[mcp_servers.x]` table name present in a TOML file. */
function codexServerNames(content: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm;

  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    names.push(match[1] ?? match[2]!);
  }

  return names;
}

/* ------------------------------------------------------------ operations -- */

async function writeAtomic(configFile: string, content: string): Promise<void> {
  await mkdir(path.dirname(configFile), { recursive: true });
  const temp = `${configFile}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, configFile);
}

export async function inspectTargetRegistration(
  root: string,
  target: TargetDefinition,
  serverName: string,
): Promise<TargetRegistrationState> {
  const configFile = path.join(root, target.mcp.file);
  const base = {
    target: target.id,
    label: target.label,
    configFile,
    relativeFile: target.mcp.file,
  };

  if (target.mcp.style === 'codex-toml') {
    let content: string | undefined;
    try {
      content = await readFile(configFile, 'utf8');
    } catch {
      content = undefined;
    }

    const registered = content !== undefined && codexTablePattern(serverName).test(content);
    return {
      ...base,
      fileExists: content !== undefined,
      registered,
      // The table is written whole, so its presence is its correctness. A
      // developer who edited it keeps whatever they wrote.
      current: registered && content!.includes(codexTable(serverName).trimEnd()),
      otherServers: (content ? codexServerNames(content) : []).filter((name) => name !== serverName),
    };
  }

  const config = await readJsonConfig(configFile);
  const key = serversKey(target.mcp.style);
  const servers = (config?.[key] as JsonServers | undefined) ?? {};
  const entry = servers[serverName];

  return {
    ...base,
    fileExists: Boolean(config),
    registered: entry !== undefined,
    current: isSameJsonEntry(entry, target.mcp.style),
    otherServers: Object.keys(servers).filter((name) => name !== serverName),
  };
}

/**
 * Adds our server to a target's configuration, preserving every other key and
 * server. Does nothing when an entry for this server already exists.
 */
export async function registerTargetServer(
  root: string,
  target: TargetDefinition,
  serverName: string,
): Promise<TargetRegisterResult> {
  const state = await inspectTargetRegistration(root, target, serverName);

  if (state.registered) {
    return { ...state, changed: false };
  }

  if (target.mcp.style === 'codex-toml') {
    let existing = '';
    try {
      existing = await readFile(state.configFile, 'utf8');
    } catch {
      existing = '';
    }

    const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await writeAtomic(state.configFile, `${existing}${separator}${codexTable(serverName)}`);
  } else {
    const config = (await readJsonConfig(state.configFile)) ?? {};
    const key = serversKey(target.mcp.style);
    const servers = { ...((config[key] as JsonServers | undefined) ?? {}) };
    servers[serverName] = desiredJsonEntry(target.mcp.style);

    // OpenCode's config is schema-validated by the tool; declaring the schema
    // makes editors useful too. Written first, where a `$schema` belongs, and
    // only when we are the ones creating the file.
    const schema =
      target.mcp.style === 'opencode' && !state.fileExists && !config.$schema
        ? { $schema: 'https://opencode.ai/config.json' }
        : {};
    const next: Record<string, unknown> = { ...schema, ...config, [key]: servers };

    await writeAtomic(state.configFile, `${JSON.stringify(next, null, 2)}\n`);
  }

  return { ...(await inspectTargetRegistration(root, target, serverName)), changed: true };
}

/** Registration state for several targets at once, in the order given. */
export async function inspectRegistrations(
  root: string,
  targets: readonly TargetId[],
  serverName: string,
): Promise<TargetRegistrationState[]> {
  const states: TargetRegistrationState[] = [];
  for (const id of targets) {
    states.push(await inspectTargetRegistration(root, TARGETS[id], serverName));
  }
  return states;
}