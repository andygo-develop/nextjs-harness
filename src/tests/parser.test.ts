import { describe, expect, it } from 'vitest';

import { HarnessError } from '../errors.js';
import {
  cleanMdx,
  parseFrontMatter,
  slugify,
  splitFrontMatter,
  toExcerpt,
} from '../rags/manuals/normalizer.js';
import {
  docsRoute,
  hashContent,
  parsePage,
  routerForPath,
  sectionForPath,
  urlForPath,
  type ParsedChunk,
} from '../rags/manuals/parser.js';
import { FIXTURE_DOCS, FIXTURE_PATHS } from './helpers.js';

const parse = (path: string, source: string, docsLine = 'v16.3.8') =>
  parsePage({ docsLine, lang: 'en', path, source });

/** Everything a page was indexed as, for asserting on what survived cleaning. */
const textOf = (chunks: ParsedChunk[]) => chunks.map((chunk) => chunk.content).join('\n');

describe('front matter', () => {
  it('splits front matter from the body', () => {
    const { frontMatter, body } = splitFrontMatter('---\ntitle: cookies\n---\n# Heading\n');
    expect(frontMatter).toBe('title: cookies');
    expect(body).toBe('# Heading\n');
  });

  it('handles a document with no front matter', () => {
    const { frontMatter, body } = splitFrontMatter('# Heading\n');
    expect(frontMatter).toBeUndefined();
    expect(body).toBe('# Heading\n');
  });

  it('reads quoted and unquoted scalars', () => {
    const meta = parseFrontMatter('title: "cookies"\ndescription: API Reference for the cookies function.\nempty:');
    expect(meta).toEqual({ title: 'cookies', description: 'API Reference for the cookies function.' });
  });

  it('reads `source:` and `nav_title:`, ignoring the nested `related:` block', () => {
    const meta = parseFrontMatter(
      [
        'title: Link',
        'nav_title: Link',
        'related:',
        '  title: Next Steps',
        '  links:',
        '    - app/api-reference/functions/use-router',
        'source: app/api-reference/components/link',
      ].join('\n'),
    );

    expect(meta).toEqual({
      title: 'Link',
      nav_title: 'Link',
      source: 'app/api-reference/components/link',
    });
  });
});

describe('slugify', () => {
  it.each([
    ['Setting a cookie', 'setting-a-cookie'],
    ['Good to know', 'good-to-know'],
    ['Understanding Cookie Behavior in Server Components', 'understanding-cookie-behavior-in-server-components'],
    ['The `cookies` Function', 'the-cookies-function'],
    ['revalidateTag()', 'revalidatetag'],
  ])('slugifies %s', (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });

  /**
   * Every pair here is a real heading and the `id` nextjs.org renders for it.
   * Anchors are GitHub-style: punctuation is dropped, not turned into a
   * hyphen, so `options.cache` is `#optionscache` — a URL ending in
   * `#options-cache` lands at the top of the page instead of the section.
   */
  it.each([
    ['What is Next.js?', 'what-is-nextjs'],
    ['`fetch(url, options)`', 'fetchurl-options'],
    ['`options.cache`', 'optionscache'],
    ['`options.next.revalidate`', 'optionsnextrevalidate'],
    [
      "Fetch default `auto no cache` and `cache: 'no-store'` not showing fresh data in development",
      'fetch-default-auto-no-cache-and-cache-no-store-not-showing-fresh-data-in-development',
    ],
    // Underscores are part of API names and survive...
    ['`unstable_cache`', 'unstable_cache'],
    ['Migrating `_document.js` and `_app.js`', 'migrating-_documentjs-and-_appjs'],
    // ...and a dropped symbol between two spaces leaves a double hyphen.
    ['CSS / Sass / SCSS decimal precision', 'css--sass--scss-decimal-precision'],
  ])('matches the nextjs.org anchor for %s', (heading, slug) => {
    expect(slugify(heading)).toBe(slug);
  });
});

describe('excerpts', () => {
  it('unwraps markdown escapes and emphasis', () => {
    expect(toExcerpt('**Good to know**: \\`cookies\\` is an *async* function in next\\.config\\.ts')).toBe(
      'Good to know: `cookies` is an async function in next.config.ts',
    );
  });

  it('keeps a backslash that is not a markdown escape', () => {
    expect(toExcerpt('Run it from C:\\Users\\acme\\blog on Windows')).toContain('C:\\Users\\acme\\blog');
  });

  it('truncates long excerpts on a word boundary', () => {
    const excerpt = toExcerpt('word '.repeat(200), 50);
    expect(excerpt.length).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('cleanMdx', () => {
  const linkBody = splitFrontMatter(FIXTURE_DOCS[FIXTURE_PATHS.link]!).body;

  it('drops a single-line editor comment', () => {
    const cleaned = cleanMdx('{/* DO NOT EDIT. The content of this doc is generated. */}\n\nBody text.\n', 'pages');
    expect(cleaned.trim()).toBe('Body text.');
  });

  it('drops a comment that spans several lines', () => {
    const cleaned = cleanMdx('{/* TODO:\n  document streaming responses\n*/}\nKept.\n', 'app');
    expect(cleaned.trim()).toBe('Kept.');
  });

  it('drops an inline comment but keeps the prose around it', () => {
    expect(cleanMdx('Use `cookies` {/* async since v15 */}to read cookies.', 'app')).toBe(
      'Use `cookies` to read cookies.',
    );
  });

  it('leaves comment syntax inside a code sample alone, since there it is real JSX', () => {
    const body = [
      '```tsx filename="app/layout.tsx" switcher',
      'export default function Layout({ children }) {',
      '  return <nav>{/* Navigation links */}{children}</nav>',
      '}',
      '```',
    ].join('\n');

    expect(cleanMdx(body, 'app')).toBe(body);
  });

  it('keeps <AppOnly> content and drops <PagesOnly> for an App Router page', () => {
    const cleaned = cleanMdx(linkBody, 'app');

    expect(cleaned).toContain('filename="app/page.tsx"');
    expect(cleaned).toContain('useLinkStatus');
    expect(cleaned).not.toContain('filename="pages/index.tsx"');
    expect(cleaned).not.toContain('JSON payload');
    expect(cleaned).not.toMatch(/<\/?(AppOnly|PagesOnly)>/);
  });

  it('keeps <PagesOnly> content and drops <AppOnly> for a Pages Router page', () => {
    const cleaned = cleanMdx(linkBody, 'pages');

    expect(cleaned).toContain('filename="pages/index.tsx"');
    expect(cleaned).toContain('JSON payload');
    expect(cleaned).not.toContain('filename="app/page.tsx"');
    expect(cleaned).not.toContain('useLinkStatus');
    expect(cleaned).not.toMatch(/<\/?(AppOnly|PagesOnly)>/);
  });

  it('keeps both variants, minus the tags, for a page outside either router', () => {
    const cleaned = cleanMdx(linkBody, undefined);

    expect(cleaned).toContain('useLinkStatus');
    expect(cleaned).toContain('JSON payload');
    expect(cleaned).not.toMatch(/<\/?(AppOnly|PagesOnly)>/);
  });

  it('drops the JavaScript twin of a switcher sample and keeps the TypeScript one', () => {
    const cleaned = cleanMdx(linkBody, 'app');

    expect(cleaned).toContain('```tsx filename="app/page.tsx" switcher');
    expect(cleaned).not.toContain('filename="app/page.js"');
    // The twin is dropped whole — fence, code and all — not just its opening line.
    expect(cleaned.match(/<Link href="\/dashboard">/g)).toHaveLength(1);
  });

  it('keeps a JavaScript sample that has no TypeScript twin', () => {
    const body = "```js filename=\"next.config.js\"\nmodule.exports = { basePath: '/docs' }\n```";
    expect(cleanMdx(body, 'app')).toBe(body);
  });
});

describe('docsRoute', () => {
  it.each([
    ['01-app/01-getting-started/06-fetching-data.mdx', 'app/getting-started/fetching-data'],
    ['01-app/03-api-reference/04-functions/cookies.mdx', 'app/api-reference/functions/cookies'],
    ['01-app/03-api-reference/05-config/01-next-config-js/index.mdx', 'app/api-reference/config/next-config-js'],
    ['02-pages/index.mdx', 'pages'],
    ['index.mdx', ''],
    // Only a *leading* number is an ordering prefix.
    ['01-app/02-guides/upgrading/version-15.mdx', 'app/guides/upgrading/version-15'],
    ['04-community/01-contribution-guide.md', 'community/contribution-guide'],
  ])('maps %s to /docs/%s', (file, route) => {
    expect(docsRoute(file)).toBe(route);
  });

  it('is the form a `source:` front-matter value points at', () => {
    const stub = parseFrontMatter(splitFrontMatter(FIXTURE_DOCS[FIXTURE_PATHS.pagesLink]!).frontMatter);
    expect(stub.source).toBe(docsRoute(FIXTURE_PATHS.link));
  });
});

describe('routerForPath', () => {
  it.each([
    [FIXTURE_PATHS.cookies, 'app'],
    [FIXTURE_PATHS.pagesLink, 'pages'],
    ['02-pages/index.mdx', 'pages'],
    ['03-architecture/fast-refresh.mdx', undefined],
    ['index.mdx', undefined],
  ])('%s belongs to %s', (file, router) => {
    expect(routerForPath(file)).toBe(router);
  });
});

describe('sectionForPath', () => {
  it.each([
    [FIXTURE_PATHS.cookies, 'App Router › API Reference'],
    [FIXTURE_PATHS.pagesLink, 'Pages Router › API Reference'],
    [FIXTURE_PATHS.routeHandlers, 'App Router › Getting Started'],
    [FIXTURE_PATHS.getStaticProps, 'Pages Router › Building Your Application'],
    // Deeper pages are still labelled by their top two levels.
    ['01-app/03-api-reference/05-config/01-next-config-js/basePath.mdx', 'App Router › API Reference'],
    ['01-app/02-guides/index.mdx', 'App Router'],
    ['01-app/index.mdx', 'App Router'],
    ['03-architecture/fast-refresh.mdx', 'Architecture'],
    ['index.mdx', 'Introduction'],
    // A directory upstream adds later is title-cased rather than dropped.
    ['05-labs/01-early-access/feature.mdx', 'Labs › Early Access'],
  ])('labels %s as %s', (file, section) => {
    expect(sectionForPath(file)).toBe(section);
  });
});

describe('urlForPath', () => {
  it('links the newest major to the unversioned nextjs.org/docs', () => {
    expect(urlForPath('v16.3.8', 'en', FIXTURE_PATHS.cookies)).toBe(
      'https://nextjs.org/docs/app/api-reference/functions/cookies',
    );
  });

  it('appends the heading anchor', () => {
    expect(urlForPath('v16.3.8', 'en', FIXTURE_PATHS.cookies, 'setting-a-cookie')).toBe(
      'https://nextjs.org/docs/app/api-reference/functions/cookies#setting-a-cookie',
    );
  });

  it('links canary, the stopgap for a newer major, to the unversioned docs as well', () => {
    expect(urlForPath('canary', 'en', FIXTURE_PATHS.cookies)).toBe(
      urlForPath('v16.3.8', 'en', FIXTURE_PATHS.cookies),
    );
  });

  it.each([
    ['v15.5.27', 15],
    ['v14.2.35', 14],
    ['v13.5.11', 13],
  ])('keeps an older major (%s) under its /docs/%i/ segment', (docsLine, major) => {
    expect(urlForPath(docsLine, 'en', FIXTURE_PATHS.cookies, 'setting-a-cookie')).toBe(
      `https://nextjs.org/docs/${major}/app/api-reference/functions/cookies#setting-a-cookie`,
    );
  });

  it('maps index pages to their directory', () => {
    expect(urlForPath('v16.3.8', 'en', 'index.mdx')).toBe('https://nextjs.org/docs');
    expect(urlForPath('v15.5.27', 'en', 'index.mdx')).toBe('https://nextjs.org/docs/15');
    expect(urlForPath('v16.3.8', 'en', '02-pages/index.mdx')).toBe('https://nextjs.org/docs/pages');
  });

  it('does not encode the language into the URL', () => {
    // nextjs.org/docs is English-only; `lang` exists for a uniform signature.
    expect(urlForPath('v16.3.8', 'en', FIXTURE_PATHS.fetch)).toBe(urlForPath('v16.3.8', 'fr', FIXTURE_PATHS.fetch));
  });

  it('rejects an unknown documentation ref rather than guessing its URL', () => {
    expect(() => urlForPath('v12.3.4', 'en', FIXTURE_PATHS.cookies)).toThrow(HarnessError);
  });
});

describe('page parsing', () => {
  const source = FIXTURE_DOCS[FIXTURE_PATHS.routeHandlers]!;
  const chunks = parse(FIXTURE_PATHS.routeHandlers, source);

  it('produces an intro chunk plus one per H2, with inline markdown stripped from headings', () => {
    expect(chunks.map((chunk) => chunk.heading)).toEqual([
      undefined,
      'Convention',
      'Supported HTTP Methods',
      'Extended NextRequest and NextResponse APIs',
      'Reading request data',
      'Revalidating cached data',
    ]);
  });

  it('takes the title from front matter and applies it to every chunk', () => {
    expect(chunks.every((chunk) => chunk.title === 'Route Handlers')).toBe(true);
  });

  it('does not treat a # comment inside a code fence as a heading', () => {
    const revalidating = chunks.find((chunk) => chunk.heading === 'Revalidating cached data')!;
    expect(revalidating.content).toContain('# Purge every cached entry tagged "posts"');
    expect(chunks.some((chunk) => chunk.heading?.includes('Purge'))).toBe(false);
  });

  it('generates stable, unique ids', () => {
    const ids = chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('v16.3.8:en:01-app/01-getting-started/15-route-handlers.mdx#_intro');
    expect(ids[1]).toBe('v16.3.8:en:01-app/01-getting-started/15-route-handlers.mdx#convention');
  });

  it('is deterministic across runs', () => {
    const again = parse(FIXTURE_PATHS.routeHandlers, source);
    expect(again.map((c) => [c.id, c.hash])).toEqual(chunks.map((c) => [c.id, c.hash]));
  });

  it('changes the hash when content changes, but keeps the id', () => {
    const edited = parse(FIXTURE_PATHS.routeHandlers, source.replace('for a given route', 'for any given route'));
    expect(edited[0]!.id).toBe(chunks[0]!.id);
    expect(edited[0]!.hash).not.toBe(chunks[0]!.hash);
  });

  it('carries version, section and url onto every chunk', () => {
    for (const chunk of chunks) {
      expect(chunk.docsLine).toBe('v16.3.8');
      expect(chunk.section).toBe('App Router › Getting Started');
      expect(chunk.url.startsWith('https://nextjs.org/docs/app/getting-started/route-handlers')).toBe(true);
    }
    expect(chunks[1]!.url).toBe('https://nextjs.org/docs/app/getting-started/route-handlers#convention');
  });

  it('links an older major to its own versioned docs', () => {
    for (const chunk of parse(FIXTURE_PATHS.routeHandlers, source, 'v15.5.27')) {
      expect(chunk.url.startsWith('https://nextjs.org/docs/15/app/getting-started/route-handlers')).toBe(true);
    }
  });

  it('indexes the TypeScript sample of each switcher pair, without editor comments', () => {
    const text = textOf(chunks);

    expect(text).toContain('```ts filename="app/api/route.ts" switcher');
    expect(text).not.toContain('app/api/route.js');
    expect(text).not.toContain('{/*');
    expect(text).not.toContain('TODO');
  });

  it('deduplicates anchors when headings repeat', () => {
    const repeated = parse('01-app/02-guides/example.mdx', '# Page\n\n## Options\n\na\n\n## Options\n\nb\n');
    expect(repeated.map((chunk) => chunk.anchor)).toEqual(['options', 'options-1']);
  });

  it('falls back to the H1 when there is no front-matter title', () => {
    const [chunk] = parse('01-app/02-guides/example.mdx', '# Self-Hosting\n\nBody text.\n');
    expect(chunk!.title).toBe('Self-Hosting');
  });

  it('falls back to the filename, without its ordering prefix, when there is no heading at all', () => {
    const [chunk] = parse('01-app/02-guides/12-self-hosting.mdx', 'Just body text.\n');
    expect(chunk!.title).toBe('Self Hosting');
  });

  it('titles an index page after its directory', () => {
    expect(parse('01-app/02-guides/index.mdx', 'Just body text.\n')[0]!.title).toBe('Guides');
    expect(parse('index.mdx', 'Just body text.\n')[0]!.title).toBe('Introduction');
  });

  it('skips empty sections', () => {
    const parsed = parse('01-app/02-guides/example.mdx', '# Page\n\n## Empty\n\n## Real\n\nContent.\n');
    expect(parsed.map((chunk) => chunk.heading)).toEqual(['Real']);
  });

  it('skips a section left empty once its router-specific content is dropped', () => {
    const parsed = parse(
      '01-app/02-guides/example.mdx',
      '# Page\n\n## Pages only\n\n<PagesOnly>\n\nOnly for pages.\n\n</PagesOnly>\n\n## Shared\n\nContent.\n',
    );
    expect(parsed.map((chunk) => chunk.heading)).toEqual(['Shared']);
  });

  it('splits very large sections instead of emitting one huge chunk', () => {
    const huge = `# Page\n\n## Big\n\n${'paragraph text here.\n\n'.repeat(1200)}`;
    const parsed = parse('01-app/02-guides/example.mdx', huge);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed.every((chunk) => chunk.content.length <= 13_000)).toBe(true);
  });

  it('hashes content stably', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });

  it('suffixes repeated headings', () => {
    const parsed = parse('01-app/02-guides/example.mdx', '# Page\n\n## Usage\n\nfirst.\n\n## Usage\n\nsecond.\n');
    expect(parsed.map((chunk) => chunk.anchor)).toEqual(['usage', 'usage-1']);
  });

  /**
   * `documents.id` is a primary key, so two chunks resolving to the same anchor
   * is not a cosmetic duplicate — the insert fails and aborts the whole index
   * run. "Usage" twice plus a literal "Usage 1" all want `usage-1`.
   */
  it('keeps anchors unique when a suffix collides with a real heading', () => {
    const parsed = parse(
      '01-app/02-guides/example.mdx',
      '# Page\n\n## Usage\n\nfirst.\n\n## Usage 1\n\nsecond.\n\n## Usage\n\nthird.\n',
    );

    const anchors = parsed.map((chunk) => chunk.anchor);
    const ids = parsed.map((chunk) => chunk.id);

    expect(anchors).toEqual(['usage', 'usage-1', 'usage-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Upstream keeps one copy of a page that both routers document: the App Router
 * page holds the content, and the Pages Router page is a stub naming it in
 * `source:` front matter. `<AppOnly>` / `<PagesOnly>` decide what each sees.
 */
describe('a Pages Router page that shares an App Router page through `source:`', () => {
  const appSource = FIXTURE_DOCS[FIXTURE_PATHS.link]!;
  const stub = FIXTURE_DOCS[FIXTURE_PATHS.pagesLink]!;

  const app = parse(FIXTURE_PATHS.link, appSource);
  const pages = parsePage({
    docsLine: 'v16.3.8',
    lang: 'en',
    path: FIXTURE_PATHS.pagesLink,
    source: stub,
    sharedSource: appSource,
  });

  it('is rendered from the shared page through the Pages Router lens', () => {
    const text = textOf(pages);

    expect(text).toContain('```tsx filename="pages/index.tsx" switcher');
    expect(text).toContain('JSON payload of pages that use');
    expect(text).not.toContain('useLinkStatus');
    expect(text).not.toContain('filename="app/page.tsx"');
    expect(text).not.toContain('DO NOT EDIT');
  });

  it('leaves the App Router original with the opposite view', () => {
    const text = textOf(app);

    expect(text).toContain('```tsx filename="app/page.tsx" switcher');
    expect(text).toContain('useLinkStatus');
    expect(text).not.toContain('JSON payload');
    expect(text).not.toContain('pages/index.tsx');
  });

  it('shares the content but keeps its own title, ids, section and URLs', () => {
    expect(pages.map((chunk) => chunk.heading)).toEqual(app.map((chunk) => chunk.heading));
    expect(app.every((chunk) => chunk.title === 'Link Component')).toBe(true);

    for (const chunk of pages) {
      // Its own front matter, not the shared page's.
      expect(chunk.title).toBe('Link');
      expect(chunk.path).toBe(FIXTURE_PATHS.pagesLink);
      expect(chunk.id.startsWith(`v16.3.8:en:${FIXTURE_PATHS.pagesLink}#`)).toBe(true);
      expect(chunk.section).toBe('Pages Router › API Reference');
      expect(chunk.url.startsWith('https://nextjs.org/docs/pages/api-reference/components/link')).toBe(true);
    }
  });

  it('yields nothing when the shared page is unavailable, rather than indexing the stub notice', () => {
    expect(parse(FIXTURE_PATHS.pagesLink, stub)).toEqual([]);
  });

  it('ignores a sharedSource for a page with no `source:` of its own', () => {
    const parsed = parsePage({
      docsLine: 'v16.3.8',
      lang: 'en',
      path: FIXTURE_PATHS.link,
      source: appSource,
      sharedSource: '# Something else entirely\n\nUnrelated.\n',
    });

    expect(parsed.map((c) => [c.id, c.hash])).toEqual(app.map((c) => [c.id, c.hash]));
  });
});
