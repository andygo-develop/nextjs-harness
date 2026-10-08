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

/**
 * A `specs.include` entry as discovery accepts it — structurally the config
 * schema's `SpecIncludeEntry`, restated here so discovery stays usable on its
 * own (tags optional).
 */
export type SpecInclude = string | { path: string; tags?: readonly string[] };

/** The glob of an include entry, whichever form it was written in. */
export function includePattern(entry: SpecInclude): string {
  return typeof entry === 'string' ? entry : entry.path;
}

/** The tags of an include entry — none for a bare glob. */
export function includeTags(entry: SpecInclude): readonly string[] {
  return typeof entry === 'string' ? [] : (entry.tags ?? []);
}

/**
 * Canonical tag form: trimmed, lower-cased, de-duplicated and sorted.
 *
 * Applied both to what is indexed and to what a search asks for, so `ADR`,
 * ` adr` and `adr` are the same tag and a stored tag list can be compared
 * for equality to decide whether a chunk needs rewriting.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ''))].sort();
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
  include: readonly SpecInclude[];
  exclude: readonly string[];
  /** Guard against pathological trees; discovery stops once reached. */
  limit?: number;
}

export interface SpecDiscovery {
  /** Project-relative POSIX paths, sorted for deterministic indexing. */
  files: string[];
  /**
   * Tags per discovered file — the union over every include entry that
   * matched it, normalized. Every file in `files` has an entry, possibly empty.
   */
  tags: Map<string, string[]>;
  /** True when `limit` cut the walk short. */
  truncated: boolean;
}

export async function discoverSpecFiles(options: DiscoverSpecsOptions): Promise<SpecDiscovery> {
  const includes = options.include.map((entry) => ({
    pattern: globToRegExp(includePattern(entry)),
    tags: includeTags(entry),
  }));
  const excludes = options.exclude.map(globToRegExp);
  const excludedDirs = directoryExcluders(options.exclude);
  const limit = options.limit ?? 2000;

  const files: string[] = [];
  const tags = new Map<string, string[]>();
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
      const matched = includes.filter((include) => include.pattern.test(relative));
      if (matched.length === 0 || matchesAny(relative, excludes)) {
        continue;
      }

      files.push(relative);
      tags.set(relative, normalizeTags(matched.flatMap((include) => include.tags)));
      if (files.length >= limit) {
        truncated = true;
        return;
      }
    }
  };

  await walk('');

  return { files: files.sort(), tags, truncated };
}
