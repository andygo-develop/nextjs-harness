/**
 * Finding the project's own spec/documentation files.
 *
 * Deliberately dependency-free: a small glob matcher plus a directory walk,
 * rather than pulling in a glob library or Node's experimental `fs.glob`.
 * That keeps behaviour deterministic and testable, and lets the walk prune
 * excluded directories instead of listing a whole `vendor/` tree first.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Directories never worth descending into, whatever the config says. */
const ALWAYS_SKIP = new Set(['.git']);

/**
 * Compiles a glob to a RegExp matched against POSIX-style relative paths.
 *
 * Supports `**` (any number of segments), `*` (within one segment) and `?`.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` — zero or more leading segments.
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

export function matchesAny(relativePath: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(relativePath));
}

/**
 * Directory-level exclusions derived from patterns like `vendor/**`, so the
 * walk can skip the subtree rather than filtering its files one by one.
 */
function directoryExcluders(exclude: readonly string[]): RegExp[] {
  return exclude
    .filter((pattern) => pattern.endsWith('/**'))
    .map((pattern) => globToRegExp(pattern.slice(0, -'/**'.length)));
}

export interface DiscoverSpecsOptions {
  root: string;
  include: readonly string[];
  exclude: readonly string[];
  /** Guard against pathological trees; discovery stops once reached. */
  limit?: number;
}

export interface SpecDiscovery {
  /** Project-relative POSIX paths, sorted for deterministic indexing. */
  files: string[];
  /** True when `limit` cut the walk short. */
  truncated: boolean;
}

export async function discoverSpecFiles(options: DiscoverSpecsOptions): Promise<SpecDiscovery> {
  const includes = options.include.map(globToRegExp);
  const excludes = options.exclude.map(globToRegExp);
  const excludedDirs = directoryExcluders(options.exclude);
  const limit = options.limit ?? 2000;

  const files: string[] = [];
  let truncated = false;

  const walk = async (relativeDir: string): Promise<void> => {
    if (truncated) {
      return;
    }

    let entries;
    try {
      entries = await readdir(path.join(options.root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) {
        return;
      }
      // Symlinks are skipped: following them could walk outside the project.
      if (entry.isSymbolicLink()) {
        continue;
      }

      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name) || matchesAny(relative, excludedDirs)) {
          continue;
        }
        await walk(relative);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (!matchesAny(relative, includes) || matchesAny(relative, excludes)) {
        continue;
      }

      files.push(relative);
      if (files.length >= limit) {
        truncated = true;
        return;
      }
    }
  };

  await walk('');

  return { files: files.sort(), truncated };
}
