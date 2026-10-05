/**
 * Detects the Next.js version a project is actually running.
 *
 * package-lock.json is preferred because it records the resolved version
 * ("16.1.4"), whereas package.json only records the range ("^16.0.0") which
 * may span minors. We fall back to the range when there is no lock file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError } from '../../errors.js';
import { buildVersion, parseConstraint, parseExact, type NextJsVersion } from './version.js';

export const NEXTJS_PACKAGE = 'next';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLockJson {
  /** lockfileVersion 2/3 layout: keyed by node_modules path. */
  packages?: Record<string, { version?: string } | undefined>;
  /** lockfileVersion 1 layout: keyed by package name. */
  dependencies?: Record<string, { version?: string } | undefined>;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new HarnessError(`${path.basename(file)} is not valid JSON.`, {
      hint: `Fix the syntax error in:\n\n  ${file}`,
      cause,
    });
  }
}

/** Finds the resolved version of `next` in a package-lock.json's `packages` map. */
function resolveFromPackagesMap(packages: PackageLockJson['packages']): string | undefined {
  if (!packages) {
    return undefined;
  }

  // The common case: a top-level dependency, not hoisted inside a workspace.
  const direct = packages[`node_modules/${NEXTJS_PACKAGE}`]?.version;
  if (direct) {
    return direct;
  }

  // Workspaces/monorepos can nest it under another package's node_modules.
  for (const [key, entry] of Object.entries(packages)) {
    if (key.endsWith(`/node_modules/${NEXTJS_PACKAGE}`) && entry?.version) {
      return entry.version;
    }
  }

  return undefined;
}

/** Reads the resolved next version from package-lock.json, if present. */
export async function detectFromLock(projectRoot: string): Promise<NextJsVersion | undefined> {
  const lock = await readJson<PackageLockJson>(path.join(projectRoot, 'package-lock.json'));
  if (!lock) {
    return undefined;
  }

  const version = resolveFromPackagesMap(lock.packages) ?? lock.dependencies?.[NEXTJS_PACKAGE]?.version;
  if (!version) {
    return undefined;
  }

  const parts = parseExact(version);
  if (!parts) {
    // e.g. a "github:vercel/next.js#..." spec — not a resolvable release, fall through to package.json.
    return undefined;
  }

  return buildVersion(parts, 'package-lock.json', version.replace(/^v/, ''));
}

/** Reads the next range from package.json, if present. */
export async function detectFromPackageJson(projectRoot: string): Promise<NextJsVersion | undefined> {
  const pkg = await readJson<PackageJson>(path.join(projectRoot, 'package.json'));
  if (!pkg) {
    return undefined;
  }

  const range = pkg.dependencies?.[NEXTJS_PACKAGE] ?? pkg.devDependencies?.[NEXTJS_PACKAGE];
  if (!range) {
    return undefined;
  }

  const parts = parseConstraint(range);
  if (!parts) {
    return undefined;
  }

  return buildVersion(parts, 'package.json');
}

/**
 * Detects the project's Next.js version, preferring the lock file.
 * Returns undefined when the project does not depend on Next.js at all.
 */
export async function detectNextJsVersion(projectRoot: string): Promise<NextJsVersion | undefined> {
  return (await detectFromLock(projectRoot)) ?? (await detectFromPackageJson(projectRoot));
}
