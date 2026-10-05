import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { indexManuals } from '../rags/manuals/indexer.js';
import { parsePage } from '../rags/manuals/parser.js';
import { ManualRepository } from '../rags/manuals/repository.js';
import { buildMatchExpression, searchManuals, tokenizeQuery } from '../rags/manuals/search.js';
import { cleanupTempDirs, FIXTURE_DOCS, FIXTURE_PATHS, makeIndexedProject } from './helpers.js';

afterEach(cleanupTempDirs);

describe('query tokenization', () => {
  it('splits a natural language query', () => {
    expect(tokenizeQuery('set a cookie')).toEqual(['set', 'a', 'cookie']);
  });

  it('splits a module specifier on its separators', () => {
    expect(tokenizeQuery('next/navigation')).toEqual(['next', 'navigation']);
    expect(tokenizeQuery('@next/font')).toEqual(['next', 'font']);
  });

  it('splits a file convention into its parts', () => {
    expect(tokenizeQuery('next.config.ts')).toEqual(['next', 'config', 'ts']);
    expect(tokenizeQuery('app/[slug]/page.tsx')).toEqual(['app', 'slug', 'page', 'tsx']);
  });

  it('drops call parentheses from a function name', () => {
    expect(tokenizeQuery('revalidateTag()')).toEqual(['revalidateTag']);
  });

  it('keeps an underscore, which is part of names like unstable_cache', () => {
    expect(tokenizeQuery('unstable_cache')).toEqual(['unstable_cache']);
  });

  it('handles operator characters that would break raw FTS5 syntax', () => {
    expect(tokenizeQuery("(await cookies()).get('theme')")).toEqual(['await', 'cookies', 'get', 'theme']);
    expect(tokenizeQuery('a OR b AND (c NOT d)')).toEqual(['a', 'OR', 'b', 'AND', 'c', 'NOT', 'd']);
  });

  it('keeps quoted phrases together', () => {
    expect(tokenizeQuery('"use client" boundary')).toEqual(['use client', 'boundary']);
  });

  it('reduces punctuation inside a quoted phrase to spaces', () => {
    expect(tokenizeQuery('"next/navigation" useRouter')).toEqual(['next navigation', 'useRouter']);
  });

  it('returns nothing for a query with no usable characters', () => {
    expect(tokenizeQuery('!!! ???')).toEqual([]);
  });

  it('quotes every term so operators are never interpreted', () => {
    expect(buildMatchExpression(['a', 'OR', 'b'])).toBe('"a" AND "OR" AND "b"');
  });

  it('escapes embedded double quotes', () => {
    expect(buildMatchExpression(['say"hi'])).toBe('"say""hi"');
  });
});

describe('search', () => {
  let root: string;
  let repository: ManualRepository;

  beforeEach(async () => {
    ({ root } = await makeIndexedProject({ constraint: '^16.1.0' }));
    repository = ManualRepository.open(harnessPaths(root).indexFile);
  });

  afterEach(() => repository.close());

  const search = (query: string, limit = 5) =>
    searchManuals({ repository, docsLine: 'v16.3.8', lang: 'en', query, limit });

  it('finds documents for a natural language query', async () => {
    const { hits } = await search('set a cookie');
    expect(hits[0]).toMatchObject({ title: 'cookies', heading: 'Setting a cookie' });
  });

  it('finds an exact Next.js API name', async () => {
    const { hits } = await search('NextResponse');
    expect(hits[0]).toMatchObject({
      title: 'Route Handlers',
      heading: 'Extended NextRequest and NextResponse APIs',
    });
  });

  it('finds a function name written as a call', async () => {
    const { hits } = await search('revalidateTag()');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe('revalidateTag');
  });

  it('matches a quoted phrase only where its words are adjacent', async () => {
    const loose = await search('use server', 10);
    const phrase = await search('"use server"', 10);

    expect(phrase.hits.length).toBeGreaterThan(0);
    // "use" and "server" both appear in plenty of prose; the directive does not.
    expect(phrase.hits.length).toBeLessThan(loose.hits.length);
    for (const hit of phrase.hits) {
      expect(hit.content).toContain("'use server'");
    }
  });

  it('does not throw on queries full of FTS5 operator characters', async () => {
    for (const query of [
      'fetch()',
      "(await cookies()).get('theme')",
      'a AND (b OR c)',
      '@next/font',
      'app/[slug]/page.tsx',
      'NEAR(cache, 2)',
      '"use client"',
      '"',
      '*',
    ]) {
      await expect(search(query)).resolves.not.toThrow();
    }
  });

  it('ranks a title match above an incidental mention', async () => {
    const titles = (await search('cookies', 10)).hits.map((hit) => hit.title);

    expect(titles[0]).toBe('cookies');
    // Route Handlers mentions cookies in passing; every cookies section beats it.
    expect(titles).toContain('Route Handlers');
    expect(titles.indexOf('Route Handlers')).toBeGreaterThan(titles.lastIndexOf('cookies'));
  });

  it('returns scores in ascending bm25 order (best first)', async () => {
    const { hits } = await search('cookies');
    const scores = hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it('respects the limit', async () => {
    expect((await search('the', 2)).hits.length).toBeLessThanOrEqual(2);
  });

  it('widens from all-terms to any-term when nothing matches everything', async () => {
    const strict = await search('cookies nonexistentterm');
    expect(strict.strategy).toBe('any-term');
    expect(strict.hits.length).toBeGreaterThan(0);
  });

  it('falls back to prefix matching for a partial word', async () => {
    const outcome = await search('cook');
    expect(outcome.strategy).toBe('prefix');
    expect(outcome.hits[0]!.title).toBe('cookies');
  });

  it('reports no results for a query that matches nothing', async () => {
    const outcome = await search('zzzznotpresentanywhere');
    expect(outcome.hits).toEqual([]);
    expect(outcome.strategy).toBe('none');
  });

  it('returns an empty result for an unusable query rather than throwing', async () => {
    expect((await search('!!!')).hits).toEqual([]);
  });

  it('includes a snippet and full metadata on each hit', async () => {
    const [hit] = (await search('set a cookie')).hits;
    expect(hit).toMatchObject({
      id: `v16.3.8:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`,
      docsLine: 'v16.3.8',
      lang: 'en',
      path: FIXTURE_PATHS.cookies,
      section: 'App Router › API Reference',
      url: 'https://nextjs.org/docs/app/api-reference/functions/cookies#setting-a-cookie',
    });
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });

  it('answers router-specific questions only from the router they belong to', async () => {
    // <AppOnly> content of the shared Link page...
    const app = (await search('useLinkStatus', 10)).hits;
    expect(app.length).toBeGreaterThan(0);
    expect(app.every((hit) => hit.path === FIXTURE_PATHS.link)).toBe(true);

    // ...and its <PagesOnly> content.
    const pages = (await search('getStaticProps', 10)).hits.map((hit) => hit.path);
    expect(pages).toContain(FIXTURE_PATHS.pagesLink);
    expect(pages).not.toContain(FIXTURE_PATHS.link);
  });
});

describe('version isolation', () => {
  it('never returns documents from another major version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8', 'v15.5.27'] });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      // Both corpora are indexed and contain the same fixture content.
      expect(repository.countDocuments('v16.3.8', 'en')).toBeGreaterThan(0);
      expect(repository.countDocuments('v15.5.27', 'en')).toBeGreaterThan(0);

      const { hits } = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query: 'cookies',
        limit: 20,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.docsLine === 'v16.3.8')).toBe(true);
      expect(hits.every((hit) => hit.url.startsWith('https://nextjs.org/docs/'))).toBe(true);
      expect(hits.some((hit) => hit.url.includes('/docs/15/'))).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('links each corpus to its own version of nextjs.org/docs', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8', 'v15.5.27'] });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      const { hits } = await searchManuals({
        repository,
        docsLine: 'v15.5.27',
        lang: 'en',
        query: 'cookies',
        limit: 20,
      });

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.url.startsWith('https://nextjs.org/docs/15/'))).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('keeps identical content in separate corpora under distinct ids', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8', 'v15.5.27'] });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      expect(repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`)).toBeDefined();
      expect(repository.getDocument(`v15.5.27:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`)).toBeDefined();
    } finally {
      repository.close();
    }
  });
});

describe('indexing', () => {
  it('indexes a Pages Router page from the App Router page it shares', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      const shared = repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.pagesLink}#prefetching`);

      expect(shared).toMatchObject({
        title: 'Link',
        section: 'Pages Router › API Reference',
        url: 'https://nextjs.org/docs/pages/api-reference/components/link#prefetching',
      });
      expect(shared!.content).toContain('JSON payload of pages that use');
      expect(shared!.content).not.toContain('useLinkStatus');
    } finally {
      repository.close();
    }
  });

  it('stores the TypeScript sample of a switcher pair, not its JavaScript twin', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);

    try {
      const { content } = repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`)!;

      expect(content).toContain('```ts filename="app/actions.ts" switcher');
      expect(content).not.toContain('app/actions.js');
    } finally {
      repository.close();
    }
  });

  /**
   * A page whose heading slugs collide used to produce two chunks with one id,
   * and the resulting primary-key violation did not skip that page — it threw
   * out of `indexManuals` and left the entire corpus unindexed.
   */
  it('indexes a page whose headings resolve to colliding anchors', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^16.1.0',
      docs: {
        [FIXTURE_PATHS.cookies]:
          '---\ntitle: cookies\n---\n\n## Usage\n\nFirst.\n\n## Usage 1\n\nSecond.\n\n## Usage\n\nThird.\n',
      },
    });

    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      expect(repository.countDocuments('v16.3.8', 'en')).toBe(3);
    } finally {
      repository.close();
    }
  });

  it('reports no work on an unchanged re-index', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);

    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('v16.3.8'),
        docsLine: 'v16.3.8',
        lang: 'en',
      });

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.unchanged).toBeGreaterThan(0);
    } finally {
      repository.close();
    }
  });

  it('updates only the chunks whose content changed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const paths = harnessPaths(root);
    const page = join(paths.manualDir('v16.3.8'), FIXTURE_PATHS.routeHandlers);

    // One sentence in one section changes upstream.
    await writeFile(
      page,
      FIXTURE_DOCS[FIXTURE_PATHS.routeHandlers]!.replace(
        'If an unsupported method is called',
        'When a handler does not export the requested method',
      ),
      'utf8',
    );

    const repository = ManualRepository.open(paths.indexFile);
    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('v16.3.8'),
        docsLine: 'v16.3.8',
        lang: 'en',
      });

      expect(result.updated).toBe(1);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
      expect(
        repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.routeHandlers}#supported-http-methods`)!.content,
      ).toContain('When a handler does not export the requested method');
    } finally {
      repository.close();
    }
  });

  it('removes documents for files deleted upstream', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const paths = harnessPaths(root);
    const page = join(paths.manualDir('v16.3.8'), FIXTURE_PATHS.routeHandlers);
    const chunks = parsePage({
      docsLine: 'v16.3.8',
      lang: 'en',
      path: FIXTURE_PATHS.routeHandlers,
      source: await readFile(page, 'utf8'),
    });

    await rm(page);

    const repository = ManualRepository.open(paths.indexFile);
    try {
      expect(repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.routeHandlers}#convention`)).toBeDefined();

      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('v16.3.8'),
        docsLine: 'v16.3.8',
        lang: 'en',
      });

      expect(result.removed).toBe(chunks.length);
      expect(repository.getDocument(`v16.3.8:en:${FIXTURE_PATHS.routeHandlers}#convention`)).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it('keeps the FTS index in step after an update, dropping superseded text', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const paths = harnessPaths(root);

    const page = join(paths.manualDir('v16.3.8'), FIXTURE_PATHS.routeHandlers);
    const write = (body: string) =>
      writeFile(page, `---\ntitle: Route Handlers\n---\n\nIntro.\n\n## Convention\n\n${body}\n`, 'utf8');
    const reindex = (repository: ManualRepository) =>
      indexManuals({ repository, manualDir: paths.manualDir('v16.3.8'), docsLine: 'v16.3.8', lang: 'en' });
    const find = async (repository: ManualRepository, query: string) =>
      (await searchManuals({ repository, docsLine: 'v16.3.8', lang: 'en', query, limit: 5 })).hits;

    const repository = ManualRepository.open(paths.indexFile);
    try {
      await write('Contains originaluniquetoken here.');
      await reindex(repository);
      expect(await find(repository, 'originaluniquetoken')).toHaveLength(1);

      await write('Contains replacementuniquetoken here.');
      await reindex(repository);

      // The new text is searchable...
      expect(await find(repository, 'replacementuniquetoken')).toHaveLength(1);
      // ...and the superseded text is genuinely gone, not merely outranked.
      expect(await find(repository, 'originaluniquetoken')).toHaveLength(0);
    } finally {
      repository.close();
    }
  });
});
