/**
 * Synchronises the official Next.js documentation.
 *
 * Source of truth is the vercel/next.js monorepo itself — the source for
 * nextjs.org/docs — which keeps MDX under `docs/**\/*.mdx` with numbered
 * path segments (`01-app/01-getting-started/…`) and no per-language
 * subdirectory (the docs are English-only). `docsLine` (see
 * `../../cli/nextjs/version.ts`) is a real git ref — a pinned release tag
 * such as `v16.3.8`, or `canary` as a stopgap for a major newer than any tag
 * we know about yet.
 *
 * The monorepo is far too large to pull as a tarball for a few hundred
 * documents, so sync works on the `docs/` subtree only:
 *
 *   1. resolve the ref to a commit SHA (one API request);
 *   2. list the `docs/` tree at that commit (one API request) — its tree SHA
 *      changes only when a documentation file does, so an unchanged tree
 *      means there is nothing to download, even on a moving ref like canary;
 *   3. fetch each document from raw.githubusercontent.com, pinned to the
 *      commit, which does not count against the API rate limit.
 */
import { mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError } from '../../errors.js';
import { logger } from '../../logger.js';

export const DEFAULT_REPOSITORY = 'vercel/next.js';
/** Directory inside the repository that holds the documentation. */
export const DOCS_DIR = 'docs';
/** How many documents are fetched at once. */
const DOWNLOAD_CONCURRENCY = 8;
const USER_AGENT = 'nextjs-harness';

/**
 * Request headers, authenticated when the environment offers a token.
 *
 * Unauthenticated GitHub API requests are rate-limited per IP, which a shared
 * office address or CI runner burns through quickly — and the rate-limit error
 * below tells people to set `GITHUB_TOKEN`, so the token has to actually be
 * sent. `GH_TOKEN` is accepted too, since that is what `gh` writes.
 *
 * The token is read at call time rather than at module load so a shell that
 * exports it mid-session does not need a restart, and it is only ever sent to
 * github.com hosts.
 */
function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export interface ManualMeta {
  framework: 'nextjs';
  /** Project version this corpus serves, e.g. "16.1". */
  version: string;
  /** Documentation git ref, e.g. "v16.3.8" or "canary". */
  docsLine: string;
  /**
   * Language of the synced corpus. Always "en" today — nextjs.org/docs has
   * no translated mirror — but kept as a real field rather than hardcoded
   * inline, since it is threaded through config, search and the MCP tools
   * the same way a genuinely multi-language corpus would need.
   */
  lang: string;
  source: string;
  branch: string;
  commit: string;
  /** SHA of the `docs/` tree at `commit`; unchanged tree means unchanged corpus. */
  treeSha?: string;
  syncedAt: string;
  fileCount: number;
}

export interface SyncResult {
  docsLine: string;
  lang: string;
  /** False when the remote head already matched what we had on disk. */
  changed: boolean;
  commit: string;
  previousCommit?: string;
  fileCount: number;
  meta: ManualMeta;
}

/**
 * Validates a path from the upstream `docs/` tree listing.
 *
 * The listing is untrusted. An entry is accepted only when it is a Markdown
 * or MDX file relative to `docs/`, with no absolute path, no `..` segment
 * and no NUL byte. Anything else is skipped.
 *
 * Returns the normalised relative path, or undefined to skip.
 */
export function safeDocPath(entryPath: string): string | undefined {
  const normalised = entryPath.replace(/\\/g, '/');

  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) {
    return undefined;
  }
  if (normalised.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return undefined;
  }
  if (!/\.mdx?$/.test(normalised) || normalised.includes('\0')) {
    return undefined;
  }

  return normalised;
}

/** Asserts that `target` stays inside `root` once resolved. */
export function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new HarnessError('Refusing to write documentation outside the manuals directory.', {
      hint: `Blocked path:\n\n  ${resolvedTarget}`,
    });
  }
}

async function githubJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubHeaders({ Accept: 'application/vnd.github+json' }),
    });
  } catch (cause) {
    throw new HarnessError(`Could not reach GitHub at ${url}`, {
      hint: 'Check your network connection or proxy settings, then try again.',
      cause,
    });
  }

  if (response.status === 403 || response.status === 429) {
    throw new HarnessError('GitHub rate limit reached while checking for documentation updates.', {
      hint:
        'Wait a few minutes and try again, or set GITHUB_TOKEN (or GH_TOKEN) in your\n' +
        'environment — an authenticated request gets a far higher rate limit.',
    });
  }
  if (response.status === 404) {
    throw new HarnessError(`Documentation ref not found: ${url}`, {
      hint: 'Run `nextjs-harness manuals versions` to see the available documentation lines.',
    });
  }
  if (!response.ok) {
    throw new HarnessError(`GitHub returned HTTP ${response.status} for ${url}`);
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    // A successful `fetch()` only means the headers arrived — the body is a
    // separate stream, and a connection dropped partway through surfaces here
    // as a bare `TypeError: terminated` with no message of its own.
    throw new HarnessError(`Connection to GitHub was interrupted while reading the response from ${url}`, {
      hint: 'This is usually a dropped connection. Check your network and try again.',
      cause,
    });
  }
}

/** Commit SHA a documentation ref (tag or branch) currently points at. */
export async function fetchHeadCommit(repository: string, ref: string): Promise<string> {
  const data = await githubJson<{ sha?: string }>(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
  );
  if (!data.sha) {
    throw new HarnessError(`GitHub did not return a commit for ${repository}@${ref}.`);
  }
  return data.sha;
}

export interface DocsTree {
  /** SHA of the `docs/` tree itself. */
  sha: string;
  /** Accepted document paths, relative to `docs/`. */
  files: string[];
}

/** Lists the documentation files under `docs/` at a commit. */
export async function fetchDocsTree(repository: string, commit: string): Promise<DocsTree> {
  const data = await githubJson<{
    sha?: string;
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; mode?: string }>;
  }>(`https://api.github.com/repos/${repository}/git/trees/${commit}:${DOCS_DIR}?recursive=1`);

  if (!data.sha || !Array.isArray(data.tree)) {
    throw new HarnessError(`GitHub did not return a ${DOCS_DIR}/ tree for ${repository}@${commit}.`);
  }
  if (data.truncated) {
    throw new HarnessError(`GitHub truncated the ${DOCS_DIR}/ tree listing for ${repository}@${commit}.`, {
      hint: 'The upstream layout may have changed. Please report this at https://github.com/andygo-develop/nextjs-harness/issues',
    });
  }

  // Only regular files are accepted: a symlink is a "blob" too, but with mode
  // 120000, and a submodule is a "commit" entry.
  const files = data.tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        (entry.mode === '100644' || entry.mode === '100755') &&
        typeof entry.path === 'string',
    )
    .map((entry) => safeDocPath(entry.path!))
    .filter((file): file is string => file !== undefined)
    .sort();

  return { sha: data.sha, files };
}

async function downloadDoc(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { headers: githubHeaders() });
  } catch (cause) {
    throw new HarnessError(`Could not download documentation from ${url}`, {
      hint: 'Check your network connection or proxy settings, then try again.',
      cause,
    });
  }

  if (!response.ok) {
    throw new HarnessError(`Failed to download documentation (HTTP ${response.status}).`, {
      hint: `Source: ${url}`,
    });
  }

  try {
    return await response.text();
  } catch (cause) {
    // A successful `fetch()` only means the headers arrived — a connection
    // dropped while the body streams surfaces here as a bare
    // `TypeError: terminated`, with no indication of what to do about it.
    throw new HarnessError(`Connection to GitHub was interrupted while downloading ${url}`, {
      hint: 'This is usually a dropped connection or an unstable network. Check your connection and try again.',
      cause,
    });
  }
}

/**
 * Downloads every document in `files` into `targetDir`, pinned to `commit`.
 * Returns the number of files written.
 */
export async function downloadDocs(
  repository: string,
  commit: string,
  files: string[],
  targetDir: string,
): Promise<number> {
  if (files.length === 0) {
    throw new HarnessError(`The ${DOCS_DIR}/ tree contained no Markdown or MDX files.`, {
      hint: 'The upstream layout may have changed. Please report this at https://github.com/andygo-develop/nextjs-harness/issues',
    });
  }

  await mkdir(targetDir, { recursive: true });
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (!failure && next < files.length) {
      const relative = files[next++]!;
      const destination = path.join(targetDir, relative);

      try {
        assertInside(targetDir, destination);

        const url = `https://raw.githubusercontent.com/${repository}/${commit}/${DOCS_DIR}/${relative
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        logger.debug(`Downloading ${url}`);
        const body = await downloadDoc(url);
        if (failure) {
          return;
        }

        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, body, 'utf8');
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  // The first failure stops every worker, and all of them are awaited before
  // it is rethrown: the caller deletes `targetDir` on failure, and a worker
  // still writing into it would recreate it, or fail that delete with
  // ENOTEMPTY in place of the actionable error.
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, files.length) }, worker));
  if (failure) {
    throw failure.error;
  }
  return files.length;
}

export async function readManualMeta(metaFile: string): Promise<ManualMeta | undefined> {
  try {
    return JSON.parse(await readFile(metaFile, 'utf8')) as ManualMeta;
  } catch {
    return undefined;
  }
}

export interface SyncOptions {
  docsLine: string;
  lang: string;
  version: string;
  repository?: string;
  manualDir: string;
  metaFile: string;
  /** Kept for API compatibility; documents are written straight to staging. */
  cacheDir: string;
  /** Re-download even when the remote head matches the local copy. */
  force?: boolean;
}

export async function syncManuals(options: SyncOptions): Promise<SyncResult> {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const branch = options.docsLine;
  const existing = await readManualMeta(options.metaFile);

  logger.debug(`Checking ${repository}@${branch} for updates`);
  const commit = await fetchHeadCommit(repository, branch);

  const unchanged = (current: ManualMeta | undefined): current is ManualMeta =>
    !options.force && current !== undefined && current.lang === options.lang;

  if (unchanged(existing) && existing.commit === commit) {
    return unchangedResult(options, existing);
  }

  const tree = await fetchDocsTree(repository, commit);

  // A moving ref (canary) gets new commits constantly; most never touch
  // docs/. The tree SHA is what says whether there is anything to download.
  if (unchanged(existing) && existing.treeSha === tree.sha) {
    return unchangedResult(options, existing);
  }

  // Download to a staging directory and swap, so a failed sync leaves the
  // previous corpus intact and files deleted upstream disappear locally.
  const staging = `${options.manualDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });

  let fileCount: number;
  try {
    fileCount = await downloadDocs(repository, commit, tree.files, staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await rm(options.manualDir, { recursive: true, force: true });
  await mkdir(path.dirname(options.manualDir), { recursive: true });
  await rename(staging, options.manualDir);

  const meta: ManualMeta = {
    framework: 'nextjs',
    version: options.version,
    docsLine: options.docsLine,
    lang: options.lang,
    source: `https://github.com/${repository}/tree/${branch}/${DOCS_DIR}`,
    branch,
    commit,
    treeSha: tree.sha,
    syncedAt: new Date().toISOString(),
    fileCount,
  };

  await writeFile(options.metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return {
    docsLine: options.docsLine,
    lang: options.lang,
    changed: true,
    commit,
    previousCommit: existing?.commit,
    fileCount,
    meta,
  };
}

function unchangedResult(options: SyncOptions, existing: ManualMeta): SyncResult {
  return {
    docsLine: options.docsLine,
    lang: options.lang,
    changed: false,
    commit: existing.commit,
    previousCommit: existing.commit,
    fileCount: existing.fileCount,
    meta: existing,
  };
}
