import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { specsIndexCommand, runSpecsIndex } from '../cli/commands/specs/index.js';
import { specsSearchCommand } from '../cli/commands/specs/search.js';
import { collectSpecsStatus, specsStatusCommand } from '../cli/commands/specs/status.js';
import { runInit } from '../cli/commands/init.js';
import { loadConfig, resetConfigCache, updateConfig } from '../generators/config-generator/config.js';
import { createMcpContext } from '../mcp/context.js';
import { runGetSpecTool, runSearchSpecsTool } from '../mcp/tools/search-specs.js';
import { runSearchTool } from '../mcp/tools/search-manual.js';
import { configSchema } from '../generators/config-generator/schema.js';
import { discoverSpecFiles, globToRegExp } from '../rags/specs/discovery.js';
import { parseSpec, sectionForSpecPath } from '../rags/specs/parser.js';
import { SpecRepository } from '../rags/specs/repository.js';
import { specIndexFile } from '../rags/specs/search.js';
import { runSpecsSearch } from '../cli/commands/specs/search.js';
import { DatabaseSync } from 'node:sqlite';
import { cleanupTempDirs, makeIndexedProject, makeProject } from './helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

async function capture(run: () => Promise<void>): Promise<string> {
  let output = '';
  const sink = (chunk: unknown): boolean => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(sink as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(sink as never);
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return output;
}

const SPEC_FILES: Record<string, string> = {
  'docs/billing.md': `---
title: "Billing Rules"
---

# Billing Rules

How invoicing works in this project.

## Invoice Numbering

Invoice numbers use the prefix ACME- followed by a zero-padded sequence.

## Dunning

Overdue invoices are chased after fourteen days.
`,
  'docs/adr/0001-use-nextjs.md': `# ADR 1: Use Next.js

## Decision

We adopt the Next.js 16 App Router for the storefront.
`,
  'specs/checkout.md': `# Checkout Spec

## Guest Checkout

Guests may check out without registering an account.
`,
  'README.md': `# Acme Shop

## Overview

The storefront application.
`,
  'vendor/acme/lib/docs/internal.md': '# Vendor doc\n\n## Nope\n\nShould never be indexed.\n',
  'node_modules/thing/readme.md': '# Dep\n\n## Nope\n\nShould never be indexed.\n',
  'app/articles/page.tsx': 'export default function ArticlesPage() {\n  return <h1>Articles</h1>\n}\n',
};

/** A project with config plus a realistic spread of spec-ish files. */
async function makeSpecProject(): Promise<string> {
  const root = await makeProject({ constraint: '^16.1.0' });
  await runInit(root);

  for (const [relative, content] of Object.entries(SPEC_FILES)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  resetConfigCache();
  return root;
}

describe('glob matching', () => {
  it.each([
    ['docs/**/*.md', 'docs/billing.md', true],
    ['docs/**/*.md', 'docs/adr/0001.md', true],
    ['docs/**/*.md', 'specs/other.md', false],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/billing.md', false],
    ['specs/**/*.md', 'specs/checkout.md', true],
    ['vendor/**', 'vendor/acme/x.md', true],
    ['vendor/**', 'src/vendor.md', false],
    ['docs/?.md', 'docs/a.md', true],
    ['docs/?.md', 'docs/ab.md', false],
  ])('%s vs %s', (pattern, candidate, expected) => {
    expect(globToRegExp(pattern).test(candidate)).toBe(expected);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegExp('docs/a.b.md').test('docs/a.b.md')).toBe(true);
    expect(globToRegExp('docs/a.b.md').test('docs/axbxmd')).toBe(false);
  });
});

describe('spec discovery', () => {
  const defaults = {
    include: ['docs/**/*.md', 'specs/**/*.md', '*.md'],
    exclude: ['vendor/**', 'node_modules/**', '.nextjs-harness/**', '.claude/**'],
  };

  it('finds project docs and ignores dependencies and code', async () => {
    const root = await makeSpecProject();
    const { files } = await discoverSpecFiles({ root, ...defaults });

    expect(files).toEqual([
      'README.md',
      'docs/adr/0001-use-nextjs.md',
      'docs/billing.md',
      'specs/checkout.md',
    ]);
  });

  it('never descends into excluded directories', async () => {
    const root = await makeSpecProject();
    const { files } = await discoverSpecFiles({ root, ...defaults });

    expect(files.some((file) => file.startsWith('vendor/'))).toBe(false);
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
  });

  it('honours custom include patterns', async () => {
    const root = await makeSpecProject();
    const { files } = await discoverSpecFiles({ root, include: ['specs/**/*.md'], exclude: [] });

    expect(files).toEqual(['specs/checkout.md']);
  });

  it('reports truncation when the file limit is hit', async () => {
    const root = await makeSpecProject();
    const result = await discoverSpecFiles({ root, ...defaults, limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  it('returns a deterministic order', async () => {
    const root = await makeSpecProject();
    const a = await discoverSpecFiles({ root, ...defaults });
    const b = await discoverSpecFiles({ root, ...defaults });

    expect(a.files).toEqual(b.files);
  });
});

describe('spec parsing', () => {
  it('chunks per H2 and carries the repo-relative path', () => {
    const chunks = parseSpec({ path: 'docs/billing.md', source: SPEC_FILES['docs/billing.md']! });

    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      undefined,
      'Invoice Numbering',
      'Dunning',
    ]);
    expect(chunks.every((chunk) => chunk.path === 'docs/billing.md')).toBe(true);
    expect(chunks.every((chunk) => chunk.title === 'Billing Rules')).toBe(true);
  });

  it('namespaces ids so they can never collide with manual ids', () => {
    const [chunk] = parseSpec({ path: 'docs/billing.md', source: SPEC_FILES['docs/billing.md']! });

    expect(chunk!.id.startsWith('spec:')).toBe(true);
  });

  it('derives a section from the top-level directory', () => {
    expect(sectionForSpecPath('docs/billing.md')).toBe('docs');
    expect(sectionForSpecPath('docs/adr/0001.md')).toBe('docs');
    expect(sectionForSpecPath('README.md')).toBe('(root)');
  });
});

describe('specs index command', () => {
  it('indexes project specs and opts the project in', async () => {
    const root = await makeSpecProject();
    expect((await loadConfig(root))?.specs.enabled).toBe(false);

    const result = await runSpecsIndex({ cwd: root });

    expect(result.files).toBe(4);
    expect(result.added).toBeGreaterThan(0);
    resetConfigCache();
    expect((await loadConfig(root))?.specs.enabled).toBe(true);
  });

  it('is incremental — a second run does nothing', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const second = await runSpecsIndex({ cwd: root });
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.unchanged).toBeGreaterThan(0);
  });

  it('reindexes only what changed', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    await writeFile(
      path.join(root, 'specs/checkout.md'),
      '# Checkout Spec\n\n## Guest Checkout\n\nGuests must now supply an email address.\n',
      'utf8',
    );

    const result = await runSpecsIndex({ cwd: root });
    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
  });

  it('prunes documents for deleted files', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    await rm(path.join(root, 'specs/checkout.md'));

    const result = await runSpecsIndex({ cwd: root });
    expect(result.removed).toBeGreaterThan(0);
  });

  it('explains what to do when nothing matches', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);
    await updateConfig(root, (config) => ({
      ...config,
      specs: { ...config.specs, include: ['nothing/**/*.md'] },
    }));
    resetConfigCache();

    const output = await capture(() => specsIndexCommand({ cwd: root }));
    expect(output).toContain('No project spec files matched');
    expect(output).toContain('specs.include');
  });
});

describe('specs search', () => {
  it('finds project-specific content', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const output = await capture(() => specsSearchCommand('invoice numbering', { cwd: root, limit: 3 }));

    expect(output).toContain('Billing Rules');
    expect(output).toContain('docs/billing.md');
  });

  it('tells the developer to index when spec search is not enabled', async () => {
    const root = await makeSpecProject();

    await expect(specsSearchCommand('invoice', { cwd: root })).rejects.toMatchObject({
      message: expect.stringContaining('not enabled'),
      hint: expect.stringContaining('nextjs-harness specs index'),
    });
  });
});

describe('specs status', () => {
  it('reports disabled before indexing', async () => {
    const root = await makeSpecProject();
    const status = await collectSpecsStatus({ cwd: root });

    expect(status.enabled).toBe(false);
    expect(status.indexed).toBe(false);
    expect(status.matchingFiles).toBe(4);
  });

  it('reports a current index afterwards', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const status = await collectSpecsStatus({ cwd: root });
    expect(status.enabled).toBe(true);
    expect(status.indexed).toBe(true);
    expect(status.indexedFileCount).toBe(status.matchingFiles);
  });

  it('emits JSON', async () => {
    const root = await makeSpecProject();
    const output = await capture(() => specsStatusCommand({ cwd: root, json: true }));

    expect(JSON.parse(output)).toMatchObject({ enabled: false, matchingFiles: 4 });
  });
});

describe('corpus separation', () => {
  it('keeps project specs in their own database file', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });

    expect(specIndexFile(root).endsWith('specs.sqlite')).toBe(true);
  });

  it('never returns project specs from the Next.js manual search', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(
      path.join(root, 'docs/billing.md'),
      '# Billing\n\n## Cookie Notes\n\nOur billing cookies are bespoke and undocumented upstream.\n',
      'utf8',
    );
    resetConfigCache();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const manual = await runSearchTool(createMcpContext(root), { query: 'cookies', limit: 10 });
    const results = (manual.structuredContent as { results: Array<{ documentId: string }> }).results;

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => !result.documentId.startsWith('spec:'))).toBe(true);
  });
});

describe('project spec MCP tools', () => {
  it('searches specs and labels the source', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const result = await runSearchSpecsTool(createMcpContext(root), { query: 'guest checkout' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ source: 'project-specs' });

    const structured = result.structuredContent as {
      count: number;
      results: Array<{ documentId: string; path: string }>;
    };
    expect(structured.count).toBeGreaterThan(0);
    expect(structured.results[0]!.path).toBe('specs/checkout.md');
  });

  it('retrieves a full spec document', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const context = createMcpContext(root);
    const search = await runSearchSpecsTool(context, { query: 'invoice numbering', limit: 1 });
    const documentId = (search.structuredContent as { results: Array<{ documentId: string }> })
      .results[0]!.documentId;

    const result = await runGetSpecTool(context, { documentId });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ documentId, source: 'project-specs' });
    expect(result.content[0]!.text).toContain('ACME-');
    // The header must make clear this is not framework documentation.
    expect(result.content[0]!.text).toMatch(/not Next.js framework documentation/i);
  });

  it('returns an actionable error when the project has not opted in', async () => {
    const root = await makeSpecProject();
    const result = await runSearchSpecsTool(createMcpContext(root), { query: 'billing' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('nextjs-harness specs index');
  });

  it('rejects an unknown documentId', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const result = await runGetSpecTool(createMcpContext(root), { documentId: 'spec:nope.md#x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('search_project_specs');
  });
});

const TAGGED_INCLUDE = [
  { path: 'docs/**/*.md', tags: ['docs'] },
  { path: 'docs/adr/**/*.md', tags: ['ADR'] },
  { path: 'specs/**/*.md', tags: ['specs'] },
  '*.md',
];

/** A spec project whose config tags its include paths. */
async function makeTaggedSpecProject(include: unknown[] = TAGGED_INCLUDE): Promise<string> {
  const root = await makeSpecProject();
  await updateConfig(root, (current) => ({
    ...current,
    specs: { ...current.specs, include: include as typeof current.specs.include },
  }));
  resetConfigCache();
  return root;
}

describe('spec include tags', () => {
  describe('config', () => {
    const base = {
      configVersion: 1,
      nextjs: { version: '16.1', docsLine: 'v16.3.8' },
      manuals: {},
      index: {},
      mcp: {},
    };

    it('accepts a mix of bare globs and tagged entries', () => {
      const config = configSchema.parse({
        ...base,
        specs: { include: [{ path: 'docs/**/*.md', tags: ['docs'] }, { path: 'specs/**/*.md' }, '*.md'] },
      });

      expect(config.specs.include).toEqual([
        { path: 'docs/**/*.md', tags: ['docs'] },
        { path: 'specs/**/*.md', tags: [] },
        '*.md',
      ]);
    });

    it('keeps the plain-string defaults, so older configs need no migration', () => {
      expect(configSchema.parse(base).specs.include).toEqual(['docs/**/*.md', 'specs/**/*.md', '*.md']);
    });

    it('rejects an entry without a path, and empty tags', () => {
      expect(configSchema.safeParse({ ...base, specs: { include: [{ tags: ['x'] }] } }).success).toBe(false);
      expect(
        configSchema.safeParse({ ...base, specs: { include: [{ path: 'docs/**', tags: ['  '] }] } }).success,
      ).toBe(false);
    });

    it('survives a save and reload', async () => {
      const root = await makeTaggedSpecProject();
      const config = await loadConfig(root);

      expect(config!.specs.include).toEqual(TAGGED_INCLUDE);
    });
  });

  it('tags each file with the union of every matching entry, normalized', async () => {
    const root = await makeSpecProject();
    const { files, tags } = await discoverSpecFiles({ root, include: TAGGED_INCLUDE, exclude: ['vendor/**', 'node_modules/**'] });

    expect(files).toContain('README.md');
    expect(tags.get('docs/adr/0001-use-nextjs.md')).toEqual(['adr', 'docs']);
    expect(tags.get('docs/billing.md')).toEqual(['docs']);
    expect(tags.get('specs/checkout.md')).toEqual(['specs']);
    expect(tags.get('README.md')).toEqual([]);
  });

  it('carries tags onto every parsed chunk', () => {
    const chunks = parseSpec({
      path: 'docs/billing.md',
      source: SPEC_FILES['docs/billing.md']!,
      tags: ['Billing', 'docs', 'docs'],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tags.join() === 'billing,docs')).toBe(true);
  });

  it('filters search results to specs carrying at least one requested tag', async () => {
    const root = await makeTaggedSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    const all = await runSpecsSearch('next', { cwd: root, limit: 25 });
    expect(all.hits.map((hit) => hit.path)).toContain('docs/adr/0001-use-nextjs.md');

    const adr = await runSpecsSearch('storefront', { cwd: root, limit: 25, tags: ['adr'] });
    expect(adr.hits.map((hit) => hit.path)).toEqual(['docs/adr/0001-use-nextjs.md']);
    expect(adr.hits[0]!.tags).toEqual(['adr', 'docs']);

    // Any one tag is enough; matching is case-insensitive.
    const either = await runSpecsSearch('guest OR invoice', { cwd: root, limit: 25, tags: ['SPECS', 'nope'] });
    expect(new Set(either.hits.map((hit) => hit.path))).toEqual(new Set(['specs/checkout.md']));

    const none = await runSpecsSearch('storefront', { cwd: root, tags: ['nope'] });
    expect(none.hits).toEqual([]);
  });

  it('applies the limit after filtering, not before', async () => {
    const root = await makeTaggedSpecProject();
    await runSpecsIndex({ cwd: root });
    resetConfigCache();

    // "storefront" matches README (untagged) and the ADR; with limit 1 the
    // filtered search must still find the ADR rather than an empty page.
    const outcome = await runSpecsSearch('storefront', { cwd: root, limit: 1, tags: ['adr'] });
    expect(outcome.hits.map((hit) => hit.path)).toEqual(['docs/adr/0001-use-nextjs.md']);
  });

  it('rewrites tags when only the config changed', async () => {
    const root = await makeSpecProject();
    await runSpecsIndex({ cwd: root });

    await updateConfig(root, (current) => ({
      ...current,
      specs: { ...current.specs, include: TAGGED_INCLUDE as typeof current.specs.include },
    }));
    resetConfigCache();

    const result = await runSpecsIndex({ cwd: root });
    expect(result.updated).toBeGreaterThan(0);
    expect(result.added).toBe(0);

    resetConfigCache();
    const outcome = await runSpecsSearch('guest checkout', { cwd: root, tags: ['specs'] });
    expect(outcome.hits[0]!.path).toBe('specs/checkout.md');

    // And a third run with nothing changed is a no-op again.
    resetConfigCache();
    const again = await runSpecsIndex({ cwd: root });
    expect(again.updated + again.added + again.removed).toBe(0);
  });

  it('upgrades a version-1 index in place', async () => {
    const root = await makeSpecProject();
    const file = specIndexFile(root);
    await mkdir(path.dirname(file), { recursive: true });

    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE spec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO spec_meta VALUES ('schema_version', '1');
      CREATE TABLE specs (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT, anchor TEXT,
        section TEXT NOT NULL, content TEXT NOT NULL, hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO specs VALUES ('spec:a.md#_intro', 'a.md', 'A', NULL, NULL, '(root)', 'alpha', 'h', 'now');
      CREATE TABLE spec_vectors (
        id TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY (id, model)
      );
    `);
    legacy.close();

    const repository = SpecRepository.open(file);
    try {
      repository.upsertVector('spec:a.md#_intro', 'm', Float32Array.from([1, 0]));
      expect(repository.count()).toBe(1);
      expect(repository.get('spec:a.md#_intro')!.tags).toEqual([]);
      expect(repository.vectorCount('m')).toBe(1);
    } finally {
      repository.close();
    }
  });

  it('shows tagged include entries in specs status', async () => {
    const root = await makeTaggedSpecProject();
    const output = await capture(() => specsStatusCommand({ cwd: root }));

    expect(output).toContain('docs/adr/**/*.md [ADR]');
    expect(output).toContain('*.md');
  });

  describe('MCP tools', () => {
    it('filters search_project_specs by tags and reports each result\'s tags', async () => {
      const root = await makeTaggedSpecProject();
      await runSpecsIndex({ cwd: root });
      resetConfigCache();

      const context = createMcpContext(root);
      const result = await runSearchSpecsTool(context, { query: 'storefront', tags: ['adr'] });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        results: Array<{ path: string; tags: string[] }>;
      };
      expect(structured.results).toEqual([
        expect.objectContaining({ path: 'docs/adr/0001-use-nextjs.md', tags: ['adr', 'docs'] }),
      ]);
      expect(result.content[0]!.text).toContain('tags: adr, docs');

      const unfiltered = await runSearchSpecsTool(context, { query: 'storefront' });
      const paths = (unfiltered.structuredContent as { results: Array<{ path: string }> }).results.map(
        (entry) => entry.path,
      );
      expect(paths).toContain('README.md');
    });

    it('says which tags found nothing', async () => {
      const root = await makeTaggedSpecProject();
      await runSpecsIndex({ cwd: root });
      resetConfigCache();

      const result = await runSearchSpecsTool(createMcpContext(root), { query: 'storefront', tags: ['nope'] });

      expect(result.content[0]!.text).toContain('with tags: nope');
      expect(result.structuredContent).toMatchObject({ count: 0 });
    });

    it('returns tags from get_project_spec', async () => {
      const root = await makeTaggedSpecProject();
      await runSpecsIndex({ cwd: root });
      resetConfigCache();

      const context = createMcpContext(root);
      const result = await runGetSpecTool(context, { documentId: 'spec:specs/checkout.md#guest-checkout' });

      expect(result.structuredContent).toMatchObject({ tags: ['specs'] });
    });
  });
});
