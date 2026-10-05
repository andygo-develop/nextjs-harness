/**
 * Registering the documentation server in Claude Code's project MCP config.
 *
 * `.mcp.json` at the project root is read by Claude Code and is normally
 * committed, so registering once gives the whole team the server.
 *
 * Claude Code is one of several supported coding agents; the merging policy —
 * never rewrite another server's entry, never touch a customised entry of our
 * own — lives in `targets/mcp.ts` and is shared by all of them. This module
 * stays as the named entry point for the Claude Code case.
 */
import { TARGETS } from './targets/registry.js';
import {
  commandArgsEntry,
  inspectTargetRegistration,
  registerTargetServer,
} from './targets/mcp.js';

export const MCP_CONFIG_FILE = '.mcp.json';

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The entry we install. `npx` resolves a local or global install alike. */
export function desiredEntry(): McpServerEntry {
  return commandArgsEntry();
}

export interface RegistrationState {
  configFile: string;
  /** .mcp.json exists. */
  fileExists: boolean;
  /** Our server name is present. */
  registered: boolean;
  /** Present and pointing at this package's `mcp start`. */
  current: boolean;
  /** Other servers already configured, left untouched. */
  otherServers: string[];
}

export interface RegisterResult extends RegistrationState {
  changed: boolean;
}

export async function inspectRegistration(
  root: string,
  serverName: string,
): Promise<RegistrationState> {
  const { configFile, fileExists, registered, current, otherServers } =
    await inspectTargetRegistration(root, TARGETS['claude-code'], serverName);

  return { configFile, fileExists, registered, current, otherServers };
}

/**
 * Adds our server to `.mcp.json`, preserving every other key and server.
 * Does nothing when an entry for this server already exists.
 */
export async function registerServer(root: string, serverName: string): Promise<RegisterResult> {
  const { configFile, fileExists, registered, current, otherServers, changed } =
    await registerTargetServer(root, TARGETS['claude-code'], serverName);

  return { configFile, fileExists, registered, current, otherServers, changed };
}