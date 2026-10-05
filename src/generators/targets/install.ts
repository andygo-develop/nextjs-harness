/**
 * Setting up one coding agent, end to end.
 *
 * Installing a target means three things — guidance, roles, and the MCP server —
 * and only the third one touches a file the developer might have opinions
 * about, so only the third one asks. Everything here is idempotent: re-running
 * after a `git pull` is the normal way to bring a checkout up to date.
 */
import path from 'node:path';

import { HARNESS_DIR } from '../../cli/nextjs/project.js';
import { installInstructions } from './instructions.js';
import { inspectTargetRegistration, registerTargetServer, type TargetRegistrationState } from './mcp.js';
import { installRoles } from './roles.js';
import { TARGETS } from './registry.js';
import {
  countByStatus,
  type FileOutcome,
  type TargetDefinition,
  type TargetId,
  type TargetPartResult,
} from './types.js';

/**
 * Each target's manifest lives in the harness directory rather than beside the
 * files it tracks: `.cursor/rules/` and `AGENTS.md` belong to the project, and
 * scattering bookkeeping dotfiles through them would be rude and confusing.
 *
 * Claude Code keeps its two original manifests where they already are, so
 * existing installs stay recognised and local edits keep being preserved.
 */
export function targetManifestFile(root: string, target: TargetId): string {
  return path.join(root, HARNESS_DIR, 'targets', `${target}.json`);
}

export interface InstallTargetOptions {
  root: string;
  serverName: string;
  /**
   * Every agent this project is set up for, which may be more than the ones
   * being installed right now. `AGENTS.md` is read by several tools, so the
   * block written there has to describe all of them or they would take turns
   * overwriting each other.
   */
  cohort?: readonly TargetId[];
  /** Overwrite locally modified files. */
  force?: boolean;
}

export interface TargetInstallResult {
  target: TargetDefinition;
  instructions: TargetPartResult;
  roles: TargetPartResult;
  /** All files written for this target, for a single-line summary. */
  files: FileOutcome[];
  counts: Record<FileOutcome['status'], number>;
}

/** Installs guidance and roles. MCP registration is separate — it asks first. */
export async function installTarget(
  target: TargetDefinition,
  options: InstallTargetOptions,
): Promise<TargetInstallResult> {
  const shared = partOptions(target, options, options.cohort ?? [target.id]);

  const instructions = await installInstructions(shared);
  const roles = await installRoles(shared);
  const files = [...instructions.files, ...roles.files];

  return { target, instructions, roles, files, counts: countByStatus(files) };
}

/** One target's outcome for a single part, for the commands that install one. */
export interface TargetPartOutcome {
  target: TargetDefinition;
  part: TargetPartResult;
}

function partOptions(
  target: TargetDefinition,
  options: InstallTargetOptions,
  cohort: readonly TargetId[],
) {
  return {
    root: options.root,
    target,
    serverName: options.serverName,
    manifestFile: targetManifestFile(options.root, target.id),
    cohort,
    force: options.force,
  };
}

/** `skill install` — guidance only, for every configured agent. */
export async function installInstructionsFor(
  targets: readonly TargetId[],
  options: InstallTargetOptions,
): Promise<TargetPartOutcome[]> {
  const outcomes: TargetPartOutcome[] = [];
  const cohort = options.cohort ?? targets;

  for (const id of targets) {
    const target = TARGETS[id];
    outcomes.push({
      target,
      part: await installInstructions(partOptions(target, options, cohort)),
    });
  }

  return outcomes;
}

/** `agent install` — roles only, for every configured agent. */
export async function installRolesFor(
  targets: readonly TargetId[],
  options: InstallTargetOptions,
): Promise<TargetPartOutcome[]> {
  const outcomes: TargetPartOutcome[] = [];
  const cohort = options.cohort ?? targets;

  for (const id of targets) {
    const target = TARGETS[id];
    outcomes.push({ target, part: await installRoles(partOptions(target, options, cohort)) });
  }

  return outcomes;
}

export async function installTargets(
  targets: readonly TargetId[],
  options: InstallTargetOptions,
): Promise<TargetInstallResult[]> {
  const results: TargetInstallResult[] = [];
  const cohort = options.cohort ?? targets;

  // Sequential on purpose: several targets share `AGENTS.md`, and two
  // concurrent merges into one file would race.
  for (const id of targets) {
    results.push(await installTarget(TARGETS[id], { ...options, cohort }));
  }

  return results;
}

export interface TargetMcpOutcome extends TargetRegistrationState {
  changed: boolean;
  /** The user declined, or the session was not interactive. */
  declined?: boolean;
}

export interface RegisterTargetsOptions {
  root: string;
  serverName: string;
  /** Asked once per target that is not already registered. */
  confirm: (target: TargetDefinition, state: TargetRegistrationState) => Promise<boolean>;
}

export async function registerTargets(
  targets: readonly TargetId[],
  options: RegisterTargetsOptions,
): Promise<TargetMcpOutcome[]> {
  const outcomes: TargetMcpOutcome[] = [];

  for (const id of targets) {
    const target = TARGETS[id];
    const state = await inspectTargetRegistration(options.root, target, options.serverName);

    if (state.registered) {
      outcomes.push({ ...state, changed: false });
      continue;
    }

    if (!(await options.confirm(target, state))) {
      outcomes.push({ ...state, changed: false, declined: true });
      continue;
    }

    outcomes.push(await registerTargetServer(options.root, target, options.serverName));
  }

  return outcomes;
}
