/**
 * Locating and describing the Next.js project we are operating on.
 */
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { notANextJsProject } from '../../errors.js';
import { detectNextJsVersion } from './detect-version.js';
import type { NextJsVersion } from './version.js';

export const HARNESS_DIR = '.nextjs-harness';

export interface NextJsProject {
  /** Absolute path to the project root (the directory holding package.json). */
  root: string;
  /** Absolute path to `<root>/.nextjs-harness`. */
  harnessDir: string;
  version: NextJsVersion;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks upward looking for a project root, preferring a directory that already
 * has a harness directory, then falling back to the nearest package.json.
 * This lets commands run from a subdirectory of the project.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | undefined> {
  let current = path.resolve(startDir);
  let packageRoot: string | undefined;

  for (;;) {
    if (await isDirectory(path.join(current, HARNESS_DIR))) {
      return current;
    }
    if (!packageRoot && (await exists(path.join(current, 'package.json')))) {
      packageRoot = current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return packageRoot;
}

/**
 * Resolves the Next.js project for the current directory.
 * Throws an actionable error when this is not a Next.js project.
 */
export async function requireNextJsProject(startDir: string = process.cwd()): Promise<NextJsProject> {
  const root = await findProjectRoot(startDir);
  if (!root) {
    throw notANextJsProject(path.resolve(startDir));
  }

  const version = await detectNextJsVersion(root);
  if (!version) {
    throw notANextJsProject(root);
  }

  return { root, harnessDir: path.join(root, HARNESS_DIR), version };
}

/** Standard paths inside the harness directory. */
export function harnessPaths(root: string) {
  const harnessDir = path.join(root, HARNESS_DIR);
  return {
    harnessDir,
    configFile: path.join(harnessDir, 'config.json'),
    manualsDir: path.join(harnessDir, 'manuals'),
    indexDir: path.join(harnessDir, 'index'),
    indexFile: path.join(harnessDir, 'index', 'docs.sqlite'),
    cacheDir: path.join(harnessDir, 'cache'),
    /** Where a given documentation line is stored, e.g. manuals/nextjs-v16.3.8. */
    manualDir: (docsLine: string) => path.join(harnessDir, 'manuals', `nextjs-${docsLine}`),
    manualMetaFile: (docsLine: string) =>
      path.join(harnessDir, 'manuals', `nextjs-${docsLine}`, '.meta.json'),
  };
}

export type HarnessPaths = ReturnType<typeof harnessPaths>;
