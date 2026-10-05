/**
 * Writing a block the harness owns into a file the *project* owns.
 *
 * `AGENTS.md` and `GEMINI.md` are the developer's files. They may already hold
 * house rules, onboarding notes or another tool's guidance, and none of that may
 * be lost to a routine `targets install`. So the harness claims a marked-off
 * region and only ever rewrites what is between its markers.
 *
 * Edits *inside* the block are respected the same way a locally edited Skill
 * file is: the manifest records the hash written last time, so a changed block
 * is recognised as the developer's work and preserved unless `--force` is given.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hashContent, readManifest, writeManifest } from '../template-installer.js';
import type { FileOutcome } from './types.js';

export const BLOCK_START = '<!-- BEGIN nextjs-harness -->';
export const BLOCK_END = '<!-- END nextjs-harness -->';

/** Matches our block including its markers, greedy-free so nesting can't run away. */
const BLOCK_PATTERN = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);

export function wrapBlock(body: string): string {
  return `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}`;
}

/** The block currently in `content`, or undefined when there is none. */
export function findBlock(content: string): string | undefined {
  return BLOCK_PATTERN.exec(content)?.[0];
}

export interface InstallManagedBlockOptions {
  root: string;
  /** Project-relative file to merge into, e.g. `AGENTS.md`. */
  file: string;
  /** Block body, without the markers. */
  body: string;
  manifestFile: string;
  templateSet: string;
  /** Overwrite a locally edited block. */
  force?: boolean;
}

export async function installManagedBlock(
  options: InstallManagedBlockOptions,
): Promise<FileOutcome> {
  const target = path.join(options.root, options.file);
  const block = wrapBlock(options.body);
  const blockHash = hashContent(block);

  let existing: string | undefined;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    existing = undefined;
  }

  const record = async (status: FileOutcome['status'], hash = blockHash): Promise<FileOutcome> => {
    await writeManifest(options.manifestFile, options.templateSet, { [options.file]: hash });
    return { file: options.file, status };
  };

  if (existing === undefined) {
    await mkdir(path.dirname(target), { recursive: true });
    await write(target, `${block}\n`);
    return record('added');
  }

  const current = findBlock(existing);

  if (current === undefined) {
    // Appended, not prepended: whatever the project already says comes first.
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    await write(target, `${existing}${separator}${block}\n`);
    return record('added');
  }

  if (current === block) {
    return record('unchanged');
  }

  const manifest = await readManifest(options.manifestFile);
  const recorded = manifest?.files[options.file];
  const currentHash = hashContent(current);

  if (recorded !== undefined && recorded !== currentHash && !options.force) {
    // Keep the recorded hash, so the block stays recognised as user-owned.
    return record('skipped', recorded);
  }

  await write(target, existing.replace(BLOCK_PATTERN, block));
  return record('updated');
}

/** Atomic write, so an interrupted run cannot truncate the project's file. */
async function write(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, target);
}

/**
 * Removes our block, leaving the rest of the file untouched.
 * Returns false when there was nothing to remove.
 */
export async function removeManagedBlock(root: string, file: string): Promise<boolean> {
  const target = path.join(root, file);

  let existing: string;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    return false;
  }

  if (!BLOCK_PATTERN.test(existing)) {
    return false;
  }

  const next = existing.replace(BLOCK_PATTERN, '').replace(/\n{3,}/g, '\n\n').trimStart();
  await write(target, next);
  return true;
}