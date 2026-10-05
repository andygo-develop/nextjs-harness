/**
 * The sync layer: GitHub API calls, docs/ tree filtering, raw downloads and
 * the staging swap that keeps a good corpus safe from a bad sync.
 *
 * Fully offline: `fetch` is replaced by an in-memory GitHub (refs pointing at
 * commits, commits holding a docs/ tree) that answers with real `Response`
 * objects — including ones whose body dies mid-transfer — and records every
 * request so tests can assert what was, and was not, fetched.
 *
 * The tree listing is untrusted input, so the path guards here are the most
 * safety-critical code in the package.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { HarnessError } from '../errors.js';
import {
  assertInside,
  DEFAULT_REPOSITORY,
  fetchDocsTree,
  fetchHeadCommit,
  readManualMeta,
  safeDocPath,
  syncManuals,
  type SyncOptions,
} from '../rags/manuals/downloader.js';
import { cleanupTempDirs, FIXTURE_DOCS, FIXTURE_PATHS, makeTempDir } from './helpers.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await cleanupTempDirs();
});

/** A deterministic 40-character git SHA. */
const sha = (label: string): string => createHash('sha1').update(label).digest('hex');

const COMMIT_1 = sha('commit-1');
const COMMIT_2 = sha('commit-2');
const TREE_1 = sha('tree-1');
const TREE_2 = sha('tree-2');

const COMMITS_URL = 'https://api.github.com/repos/vercel/next.js/commits';
const TREES_URL = 'https://api.github.com/repos/vercel/next.js/git/trees';

interface TreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

interface Snapshot {
  /** SHA of the docs/ tree. */
  treeSha: string;
  /** Documents under docs/, by path. */
  docs: Record<string, string>;
  /** Entries in the listing besides the documents and their directories. */
  extra?: TreeEntry[];
  truncated?: boolean;
}

/** A body that delivers a little, then dies — `TypeError: terminated`, as undici reports it. */
function droppedConnection(partial: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(partial.slice(0, 16)));
      controller.error(new TypeError('terminated'));
    },
  });
}

/** The recursive listing GitHub returns for a docs/ tree: directories and blobs. */
function listing({ docs, extra = [] }: Snapshot): TreeEntry[] {
  const dirs = new Set<string>();
  for (const file of Object.keys(docs)) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join('/'));
    }
  }

  return [
    ...[...dirs].map((dir) => ({ path: dir, mode: '040000', type: 'tree', sha: sha(dir) })),
    ...Object.keys(docs).map((file) => ({ path: file, mode: '100644', type: 'blob', sha: sha(file) })),
    ...extra,
  ];
}

/**
 * An in-memory github.com and raw.githubusercontent.com for vercel/next.js,
 * installed as the global `fetch`.
 */
function fakeGitHub() {
  const refs = new Map<string, string>();
  const commits = new Map<string, Snapshot>();
  const cutOff = new Set<string>();
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });

    const commit = /^https:\/\/api\.github\.com\/repos\/vercel\/next\.js\/commits\/([^/?]+)$/.exec(url);
    if (commit) {
      const resolved = refs.get(decodeURIComponent(commit[1]!));
      return resolved ? json({ sha: resolved }) : json({ message: 'Not Found' }, 404);
    }

    const tree = /^https:\/\/api\.github\.com\/repos\/vercel\/next\.js\/git\/trees\/([0-9a-f]{40}):docs\?recursive=1$/.exec(
      url,
    );
    if (tree) {
      const snapshot = commits.get(tree[1]!);
      return snapshot
        ? json({ sha: snapshot.treeSha, truncated: snapshot.truncated ?? false, tree: listing(snapshot) })
        : json({ message: 'Not Found' }, 404);
    }

    const raw = /^https:\/\/raw\.githubusercontent\.com\/vercel\/next\.js\/([0-9a-f]{40})\/docs\/(.+)$/.exec(url);
    if (raw) {
      const file = raw[2]!.split('/').map(decodeURIComponent).join('/');
      const body = commits.get(raw[1]!)?.docs[file];
      if (body === undefined) {
        return new Response('404: Not Found', { status: 404 });
      }
      return new Response(cutOff.has(file) ? droppedConnection(body) : body);
    }

    return new Response(`unexpected request: ${url}`, { status: 500 });
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    requests,
    /** Points `ref` at a new commit holding `snapshot`. */
    publish(ref: string, commit: string, snapshot: Snapshot): void {
      commits.set(commit, snapshot);
      refs.set(ref, commit);
    },
    /** Makes a document's download die partway through its body. */
    cutOff(file: string): void {
      cutOff.add(file);
    },
    to(host: 'api.github.com' | 'raw.githubusercontent.com') {
      return requests.filter((request) => new URL(request.url).host === host);
    },
    forget(): void {
      requests.length = 0;
    },
  };
}

/** Every file under `dir`, relative and sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

/** A project's sync locations for one documentation line, as the CLI computes them. */
async function syncTarget(docsLine = 'v16.3.8') {
  const paths = harnessPaths(await makeTempDir());
  const options: SyncOptions = {
    docsLine,
    lang: 'en',
    version: '16.1',
    manualDir: paths.manualDir(docsLine),
    metaFile: paths.manualMetaFile(docsLine),
    cacheDir: paths.cacheDir,
  };
  return { manualsDir: paths.manualsDir, ...options };
}

/** What upstream looks like after a docs change: one page edited, one removed, one added. */
const UPDATED_DOCS: Record<string, string> = Object.fromEntries([
  ...Object.entries(FIXTURE_DOCS).filter(([file]) => file !== FIXTURE_PATHS.getStaticProps),
  [
    FIXTURE_PATHS.cookies,
    FIXTURE_DOCS[FIXTURE_PATHS.cookies]!.replace('`cookies` introduced.', '`cookies` introduced in the App Router.'),
  ],
  [
    '01-app/03-api-reference/04-functions/updateTag.mdx',
    '---\ntitle: updateTag\ndescription: API Reference for the updateTag function.\n---\n\n`updateTag` updates cached data on-demand for a specific cache tag, from within Server Actions.\n',
  ],
]);

describe('safeDocPath', () => {
  it.each([
    FIXTURE_PATHS.cookies,
    FIXTURE_PATHS.pagesLink,
    'index.mdx',
    '04-community/01-contribution-guide.md',
  ])('accepts the documentation file %s', (entry) => {
    expect(safeDocPath(entry)).toBe(entry);
  });

  it('normalises backslashes to forward slashes', () => {
    expect(safeDocPath('01-app\\03-api-reference\\04-functions\\cookies.mdx')).toBe(FIXTURE_PATHS.cookies);
  });

  it.each([
    '01-app/02-guides/diagram.png',
    '01-app/03-api-reference/04-functions/cookies.mdx.orig',
    '.eslintrc.json',
    'scripts/check-links.sh',
    '01-app/index',
  ])('rejects the non-documentation file %s', (entry) => {
    expect(safeDocPath(entry)).toBeUndefined();
  });

  it.each([
    '../package.json.md',
    '../../../../etc/passwd.md',
    '01-app/../../escape.mdx',
    '01-app/02-guides/../../../evil.md',
    '01-app\\..\\..\\evil.mdx',
  ])('rejects path traversal: %s', (entry) => {
    expect(safeDocPath(entry)).toBeUndefined();
  });

  it.each(['/etc/passwd.md', '/docs/index.mdx', 'C:/Windows/system.md', 'c:\\evil.mdx'])(
    'rejects absolute path: %s',
    (entry) => {
      expect(safeDocPath(entry)).toBeUndefined();
    },
  );

  it.each(['01-app/./cookies.mdx', '01-app//cookies.mdx', '01-app/cookies.mdx/', ''])(
    'rejects a malformed path: %j',
    (entry) => {
      expect(safeDocPath(entry)).toBeUndefined();
    },
  );

  it('rejects a path containing a null byte', () => {
    expect(safeDocPath('01-app/evil\0.mdx')).toBeUndefined();
  });
});

describe('assertInside', () => {
  it('allows a path within the root', () => {
    expect(() => assertInside('/tmp/manuals', `/tmp/manuals/${FIXTURE_PATHS.cookies}`)).not.toThrow();
  });

  it('rejects a sibling directory that shares a prefix', () => {
    expect(() => assertInside('/tmp/manuals', '/tmp/manuals-evil/x.mdx')).toThrow(HarnessError);
  });

  it('rejects an escaping path', () => {
    expect(() => assertInside('/tmp/manuals', '/tmp/manuals/../../etc/passwd')).toThrow(HarnessError);
  });
});

describe('fetchHeadCommit', () => {
  it('resolves a release tag to the commit it points at', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: {} });

    expect(await fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).toBe(COMMIT_1);
    expect(github.requests.map((request) => request.url)).toEqual([`${COMMITS_URL}/v16.3.8`]);
  });

  it('resolves canary, a moving branch, the same way', async () => {
    const github = fakeGitHub();
    github.publish('canary', COMMIT_2, { treeSha: TREE_2, docs: {} });

    expect(await fetchHeadCommit(DEFAULT_REPOSITORY, 'canary')).toBe(COMMIT_2);
  });

  it('reports an unknown ref with a pointer to the available lines', async () => {
    fakeGitHub();

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v99.0.0')).rejects.toMatchObject({
      message: expect.stringContaining('Documentation ref not found'),
      hint: expect.stringContaining('nextjs-harness manuals versions'),
    });
  });

  it('refuses a response without a commit SHA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'unexpected shape' })));

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).rejects.toThrow(/did not return a commit/);
  });
});

describe('fetchDocsTree', () => {
  it('lists the Markdown and MDX documents under docs/, relative to it and sorted', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, {
      treeSha: TREE_1,
      docs: { 'index.mdx': 'Welcome', [FIXTURE_PATHS.cookies]: 'cookies' },
    });

    const tree = await fetchDocsTree(DEFAULT_REPOSITORY, COMMIT_1);

    expect(tree).toEqual({ sha: TREE_1, files: [FIXTURE_PATHS.cookies, 'index.mdx'] });
    // The docs/ subtree of the pinned commit, recursively — not the whole monorepo.
    expect(github.requests.map((request) => request.url)).toEqual([
      `${TREES_URL}/${COMMIT_1}:docs?recursive=1`,
    ]);
  });

  it('keeps only regular files that are documentation', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, {
      treeSha: TREE_1,
      docs: { 'index.mdx': 'Welcome' },
      extra: [
        // An executable bit does not stop a file being a regular file.
        { path: '04-community/01-contribution-guide.md', mode: '100755', type: 'blob' },
        // A symlink is a "blob" too, but its content is a path — never follow it.
        { path: '01-app/linked.mdx', mode: '120000', type: 'blob' },
        // A submodule is a "commit" entry.
        { path: 'vendored-docs', mode: '160000', type: 'commit' },
        { path: '01-app/02-guides/diagram.png', mode: '100644', type: 'blob' },
        { path: '.eslintrc.json', mode: '100644', type: 'blob' },
        { mode: '100644', type: 'blob' },
      ],
    });

    const { files } = await fetchDocsTree(DEFAULT_REPOSITORY, COMMIT_1);

    expect(files).toEqual(['04-community/01-contribution-guide.md', 'index.mdx']);
  });

  it('drops entries whose path would escape the manuals directory', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, {
      treeSha: TREE_1,
      docs: { 'index.mdx': 'Welcome' },
      extra: [
        { path: '../outside.mdx', mode: '100644', type: 'blob' },
        { path: '01-app/../../escape.md', mode: '100644', type: 'blob' },
        { path: '/etc/passwd.md', mode: '100644', type: 'blob' },
      ],
    });

    expect((await fetchDocsTree(DEFAULT_REPOSITORY, COMMIT_1)).files).toEqual(['index.mdx']);
  });

  it('refuses a truncated listing rather than syncing part of the manual', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: { 'index.mdx': 'Welcome' }, truncated: true });

    await expect(fetchDocsTree(DEFAULT_REPOSITORY, COMMIT_1)).rejects.toMatchObject({
      message: expect.stringContaining('truncated'),
      hint: expect.stringContaining('report this'),
    });
  });

  it('refuses a response that is not a tree', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha: TREE_1 })));

    await expect(fetchDocsTree(DEFAULT_REPOSITORY, COMMIT_1)).rejects.toThrow(/did not return a docs\/ tree/);
  });
});

describe('syncManuals', () => {
  it('downloads every document on the first sync and records where it came from', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();

    const result = await syncManuals(target);
    const count = Object.keys(FIXTURE_DOCS).length;

    expect(result).toMatchObject({ docsLine: 'v16.3.8', lang: 'en', changed: true, commit: COMMIT_1, fileCount: count });
    expect(result.previousCommit).toBeUndefined();
    expect(result.meta).toMatchObject({
      framework: 'nextjs',
      version: '16.1',
      docsLine: 'v16.3.8',
      lang: 'en',
      source: 'https://github.com/vercel/next.js/tree/v16.3.8/docs',
      branch: 'v16.3.8',
      commit: COMMIT_1,
      treeSha: TREE_1,
      fileCount: count,
    });
    expect(await readManualMeta(target.metaFile)).toEqual(result.meta);

    expect(await filesUnder(target.manualDir)).toEqual([...Object.keys(FIXTURE_DOCS), '.meta.json'].sort());
    for (const [file, content] of Object.entries(FIXTURE_DOCS)) {
      expect(await readFile(path.join(target.manualDir, file), 'utf8')).toBe(content);
    }

    // Documents come from raw.githubusercontent.com — outside the API rate
    // limit — pinned to the resolved commit, so a ref moving mid-sync cannot
    // mix two versions of the manual.
    const raw = github.to('raw.githubusercontent.com');
    expect(raw).toHaveLength(count);
    expect(raw.every((request) => request.url.startsWith(`https://raw.githubusercontent.com/vercel/next.js/${COMMIT_1}/docs/`))).toBe(
      true,
    );
    expect(github.to('api.github.com')).toHaveLength(2);

    // The staging directory was swapped into place, not left beside it.
    expect(await readdir(target.manualsDir)).toEqual(['nextjs-v16.3.8']);
  });

  it('makes a single API request and downloads nothing when the ref has not moved', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    const first = await syncManuals(target);
    github.forget();

    const again = await syncManuals(target);

    expect(again).toMatchObject({ changed: false, commit: COMMIT_1, previousCommit: COMMIT_1 });
    expect(again.fileCount).toBe(first.fileCount);
    expect(github.requests.map((request) => request.url)).toEqual([`${COMMITS_URL}/v16.3.8`]);
  });

  it('downloads nothing when canary moves without touching docs/', async () => {
    const github = fakeGitHub();
    github.publish('canary', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget('canary');
    await syncManuals(target);
    const before = await filesUnder(target.manualDir);

    // A new commit on canary that changed code, not documentation: same tree.
    github.publish('canary', COMMIT_2, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    github.forget();

    const result = await syncManuals(target);

    expect(result.changed).toBe(false);
    expect(github.requests.map((request) => request.url)).toEqual([
      `${COMMITS_URL}/canary`,
      `${TREES_URL}/${COMMIT_2}:docs?recursive=1`,
    ]);
    expect(github.to('raw.githubusercontent.com')).toEqual([]);
    expect(await filesUnder(target.manualDir)).toEqual(before);
  });

  it('replaces the corpus when docs/ changed, dropping pages deleted upstream', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);

    github.publish('v16.3.8', COMMIT_2, { treeSha: TREE_2, docs: UPDATED_DOCS });
    const result = await syncManuals(target);

    expect(result).toMatchObject({
      changed: true,
      commit: COMMIT_2,
      previousCommit: COMMIT_1,
      fileCount: Object.keys(UPDATED_DOCS).length,
    });
    expect(result.meta.treeSha).toBe(TREE_2);
    expect(await filesUnder(target.manualDir)).toEqual([...Object.keys(UPDATED_DOCS), '.meta.json'].sort());
    expect(await readFile(path.join(target.manualDir, FIXTURE_PATHS.cookies), 'utf8')).toContain(
      'introduced in the App Router',
    );
  });

  it('downloads again when forced, even though nothing changed', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);
    github.forget();

    const result = await syncManuals({ ...target, force: true });

    expect(result.changed).toBe(true);
    expect(github.to('raw.githubusercontent.com')).toHaveLength(Object.keys(FIXTURE_DOCS).length);
  });

  /**
   * A successful `fetch()` only proves the response headers arrived — the body
   * is a separate stream, and a connection dropped mid-transfer throws a bare
   * `TypeError: terminated` with no message when that stream is read.
   */
  it('reports a connection dropped mid-download actionably and keeps the previous corpus', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);
    const previousMeta = await readManualMeta(target.metaFile);

    github.publish('v16.3.8', COMMIT_2, { treeSha: TREE_2, docs: UPDATED_DOCS });
    github.cutOff(FIXTURE_PATHS.cookies);

    const error = await syncManuals(target).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/Connection to GitHub was interrupted while downloading .*cookies\.mdx/),
      hint: expect.stringMatching(/connection/i),
    });
    expect((error as HarnessError).cause).toBeInstanceOf(TypeError);

    // The corpus on disk is exactly the one from the last good sync...
    expect(await readManualMeta(target.metaFile)).toEqual(previousMeta);
    expect(await filesUnder(target.manualDir)).toEqual([...Object.keys(FIXTURE_DOCS), '.meta.json'].sort());
    for (const [file, content] of Object.entries(FIXTURE_DOCS)) {
      expect(await readFile(path.join(target.manualDir, file), 'utf8')).toBe(content);
    }
    // ...and the half-downloaded staging copy is gone.
    expect(await readdir(target.manualsDir)).toEqual(['nextjs-v16.3.8']);
  });

  it('stops downloading once a document fails, so nothing is written after the sync has given up', async () => {
    const github = fakeGitHub();
    // More documents than download slots, so most are still queued when the first fails.
    const docs = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `01-app/02-guides/guide-${String(i).padStart(2, '0')}.mdx`,
        `---\ntitle: Guide ${i}\n---\n\nGuide ${i}.\n`,
      ]),
    );
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs });
    github.cutOff('01-app/02-guides/guide-00.mdx');
    const target = await syncTarget();

    const error = await syncManuals(target).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const requestsWhenFailed = github.requests.length;

    // Give any download still running in the background every chance to finish.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(error).toBeInstanceOf(HarnessError);
    expect(github.requests.length).toBe(requestsWhenFailed);
    expect(github.to('raw.githubusercontent.com').length).toBeLessThan(Object.keys(docs).length);
    expect(await readdir(target.manualsDir)).toEqual([]);
  });

  it('refuses an empty docs/ tree instead of replacing the corpus with nothing', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);

    // e.g. upstream moved the documentation somewhere else.
    github.publish('v16.3.8', COMMIT_2, { treeSha: TREE_2, docs: {}, extra: [{ path: 'README', mode: '100644', type: 'blob' }] });

    await expect(syncManuals(target)).rejects.toThrow(/contained no Markdown or MDX files/);
    expect(await filesUnder(target.manualDir)).toEqual([...Object.keys(FIXTURE_DOCS), '.meta.json'].sort());
  });

  it('reports a failed document download with its URL and keeps the previous corpus', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);

    // The listing names a file the raw host then cannot serve.
    github.publish('v16.3.8', COMMIT_2, {
      treeSha: TREE_2,
      docs: FIXTURE_DOCS,
      extra: [{ path: '01-app/02-guides/missing.mdx', mode: '100644', type: 'blob' }],
    });

    await expect(syncManuals(target)).rejects.toMatchObject({
      message: 'Failed to download documentation (HTTP 404).',
      hint: expect.stringContaining(`/${COMMIT_2}/docs/01-app/02-guides/missing.mdx`),
    });
    expect((await readManualMeta(target.metaFile))?.commit).toBe(COMMIT_1);
    expect(await readdir(target.manualsDir)).toEqual(['nextjs-v16.3.8']);
  });
});

describe('GitHub authentication', () => {
  const clearTokens = (): void => {
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GH_TOKEN', undefined);
  };

  it('sends no Authorization header when no token is set', async () => {
    clearTokens();
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: {} });

    await fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8');

    const [request] = github.requests;
    expect(request!.headers.Authorization).toBeUndefined();
    expect(request!.headers['User-Agent']).toBe('nextjs-harness');
  });

  /**
   * The rate-limit error tells people to set GITHUB_TOKEN, so it has to be a
   * hint that actually does something.
   */
  it.each(['GITHUB_TOKEN', 'GH_TOKEN'])('authenticates with %s when set', async (variable) => {
    clearTokens();
    vi.stubEnv(variable, 'secret-token');
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: {} });

    await fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8');

    expect(github.requests[0]!.headers.Authorization).toBe('Bearer secret-token');
  });

  it('prefers GITHUB_TOKEN when both are set', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    vi.stubEnv('GH_TOKEN', 'gh-cli-token');
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: {} });

    await fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8');

    expect(github.requests[0]!.headers.Authorization).toBe('Bearer github-token');
  });

  it('authenticates every request of a sync, and sends the token only to GitHub', async () => {
    clearTokens();
    vi.stubEnv('GITHUB_TOKEN', 'secret-token');
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });

    await syncManuals(await syncTarget());

    expect(github.requests.length).toBeGreaterThan(2);
    for (const request of github.requests) {
      expect(request.headers.Authorization).toBe('Bearer secret-token');
      expect(['api.github.com', 'raw.githubusercontent.com']).toContain(new URL(request.url).host);
    }
  });
});

describe('GitHub failures', () => {
  it.each([403, 429])('explains a rate limit (HTTP %i) and how to raise it', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'API rate limit exceeded' }, { status })),
    );

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).rejects.toMatchObject({
      message: 'GitHub rate limit reached while checking for documentation updates.',
      hint: expect.stringMatching(/GITHUB_TOKEN \(or GH_TOKEN\)/),
    });
  });

  it('keeps the previous corpus when the rate limit hits partway through a sync', async () => {
    const github = fakeGitHub();
    github.publish('v16.3.8', COMMIT_1, { treeSha: TREE_1, docs: FIXTURE_DOCS });
    const target = await syncTarget();
    await syncManuals(target);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'API rate limit exceeded' }, { status: 403 })),
    );

    await expect(syncManuals({ ...target, force: true })).rejects.toThrow(/rate limit/);
    expect((await readManualMeta(target.metaFile))?.commit).toBe(COMMIT_1);
    expect(await filesUnder(target.manualDir)).toContain(FIXTURE_PATHS.cookies);
  });

  it('explains an unreachable GitHub', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).rejects.toMatchObject({
      message: `Could not reach GitHub at ${COMMITS_URL}/v16.3.8`,
      hint: expect.stringMatching(/network connection or proxy/),
    });
  });

  it('reports an actionable error when the commit-lookup body is interrupted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(droppedConnection('{"sha":"'))));

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).rejects.toThrow(
      /Connection to GitHub was interrupted while reading the response/,
    );
  });

  it('reports any other HTTP failure with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 502 })));

    await expect(fetchHeadCommit(DEFAULT_REPOSITORY, 'v16.3.8')).rejects.toThrow(/GitHub returned HTTP 502/);
  });
});

describe('readManualMeta', () => {
  it('returns undefined when there is no metadata file', async () => {
    const dir = await makeTempDir();
    expect(await readManualMeta(path.join(dir, '.meta.json'))).toBeUndefined();
  });

  it('returns undefined for a corrupt metadata file, so the next sync starts clean', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.meta.json');
    await writeFile(file, '{ "framework": "nextjs", ');

    expect(await readManualMeta(file)).toBeUndefined();
  });

  it('reads metadata back', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.meta.json');
    await writeFile(file, JSON.stringify({ framework: 'nextjs', version: '16.1', docsLine: 'v16.3.8', commit: COMMIT_1 }));

    expect(await readManualMeta(file)).toMatchObject({ framework: 'nextjs', version: '16.1', docsLine: 'v16.3.8' });
  });
});
