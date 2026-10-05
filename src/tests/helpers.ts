/**
 * Test helpers: build throwaway Next.js projects with a fixture manual corpus.
 *
 * Everything here is offline — no test may reach the network.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { harnessPaths } from '../cli/nextjs/project.js';
import { ensureConfig, resetConfigCache } from '../generators/config-generator/config.js';
import { buildVersion } from '../cli/nextjs/version.js';
import type { EmbeddingProvider } from '../rags/embeddings/provider.js';
import type { ManualMeta } from '../rags/manuals/downloader.js';
import { indexManuals } from '../rags/manuals/indexer.js';
import { ManualRepository } from '../rags/manuals/repository.js';

/**
 * A deterministic, dependency-free, offline stand-in for a real embedding
 * model — used everywhere hybrid search is tested. Never imports or exercises
 * the real `@huggingface/transformers` provider, which needs a network-fetched
 * model and is out of scope for "fully offline by design" tests (see
 * `src/rags/embeddings/transformers-provider.ts`).
 *
 * Vectors are character-bigram hash counts, normalised to unit length. That is
 * enough to give texts sharing vocabulary a higher cosine similarity than
 * texts that share none — sufficient to test storage, ranking and blending
 * logic — without claiming to model actual semantics the way a real
 * sentence-embedding model would.
 */
export function makeFakeEmbeddingProvider(model = 'fake-test-model', dims = 32): EmbeddingProvider {
  const embedOne = (text: string): Float32Array => {
    const vector = new Float32Array(dims);
    const normalized = text.toLowerCase();

    for (let i = 0; i < normalized.length - 1; i += 1) {
      const gram = normalized.slice(i, i + 2);
      let hash = 0;
      for (let j = 0; j < gram.length; j += 1) {
        hash = (hash * 31 + gram.charCodeAt(j)) >>> 0;
      }
      const slot = hash % dims;
      vector[slot] = vector[slot]! + 1;
    }

    let norm = 0;
    for (const value of vector) {
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;

    return vector.map((value) => value / norm);
  };

  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map(embedOne);
    },
  };
}

const createdDirs: string[] = [];

export async function makeTempDir(prefix = 'nextjs-harness-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  resetConfigCache();
}

export interface MakeProjectOptions {
  /** npm version range for `next`, e.g. "^16.1.0". Omit to write no package.json. */
  constraint?: string;
  /** Exact version for package-lock.json, e.g. "16.1.4". */
  lockVersion?: string;
  /** Write a React project that does not use Next.js. */
  nonNextJs?: boolean;
}

/** Creates a temporary project directory with a package.json / package-lock.json. */
export async function makeProject(options: MakeProjectOptions = {}): Promise<string> {
  const root = await makeTempDir();

  if (options.nonNextJs) {
    // The closest lookalike: React, but no `next` — a Vite single-page app.
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'acme-spa',
          private: true,
          dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
          devDependencies: { vite: '^7.1.0' },
        },
        null,
        2,
      ),
    );
    return root;
  }

  if (options.constraint) {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'acme-blog',
          private: true,
          scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
          dependencies: { next: options.constraint, react: '^19.2.0', 'react-dom': '^19.2.0' },
        },
        null,
        2,
      ),
    );
  }

  if (options.lockVersion) {
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'acme-blog',
          lockfileVersion: 3,
          packages: {
            '': { name: 'acme-blog' },
            'node_modules/next': { version: options.lockVersion },
          },
        },
        null,
        2,
      ),
    );
  }

  return root;
}

/**
 * Paths of the fixture pages, relative to `docs/` in vercel/next.js — the
 * upstream layout, numeric ordering prefixes and all, with the App Router and
 * Pages Router trees side by side.
 */
export const FIXTURE_PATHS = {
  intro: 'index.mdx',
  routeHandlers: '01-app/01-getting-started/15-route-handlers.mdx',
  link: '01-app/03-api-reference/02-components/link.mdx',
  cookies: '01-app/03-api-reference/04-functions/cookies.mdx',
  fetch: '01-app/03-api-reference/04-functions/fetch.mdx',
  revalidateTag: '01-app/03-api-reference/04-functions/revalidateTag.mdx',
  getStaticProps: '02-pages/03-building-your-application/03-data-fetching/01-get-static-props.mdx',
  /** A Pages Router stub whose content comes from the App Router `link` page. */
  pagesLink: '02-pages/04-api-reference/01-components/link.mdx',
} as const;

/**
 * A small but realistic fixture corpus, keyed by path under `docs/`.
 *
 * It deliberately carries the MDX the indexer has to cope with upstream:
 * `{/* *\/}` editor comments, `tsx`/`jsx` "switcher" pairs, `<AppOnly>` /
 * `<PagesOnly>` blocks, a Pages Router page that shares an App Router page's
 * content through `source:` front matter, nested `related:` front matter, and
 * a shell sample whose `#` comment must not become a heading.
 */
export const FIXTURE_DOCS: Record<string, string> = {
  [FIXTURE_PATHS.intro]: `---
title: Next.js Docs
description: Welcome to the Next.js Documentation.
related:
  title: Next Steps
  description: Create your first application and learn the core Next.js features.
  links:
    - app/getting-started
---

Welcome to the Next.js documentation!

## What is Next.js?

Next.js is a React framework for building full-stack web applications. You use React Components to build user interfaces, and Next.js for additional features and optimizations.

## App Router and Pages Router

Next.js has two different routers:

- **App Router**: The newer router that supports React features like Server Components and streaming.
- **Pages Router**: The original router, still supported and being improved.
`,

  [FIXTURE_PATHS.routeHandlers]: `---
title: Route Handlers
nav_title: Route Handlers
description: Create custom request handlers with Next.js Route Handlers using the Web Request and Response APIs.
related:
  title: API Reference
  description: Learn more about Route Handlers
  links:
    - app/api-reference/file-conventions/route
---

{/* TODO: Document streaming responses once the guide lands. */}

Route Handlers allow you to create custom request handlers for a given route using the Web [Request](https://developer.mozilla.org/docs/Web/API/Request) and [Response](https://developer.mozilla.org/docs/Web/API/Response) APIs.

> **Good to know**: Route Handlers are only available inside the \`app\` directory. They are the equivalent of [API Routes](/docs/pages/building-your-application/routing/api-routes) inside the \`pages\` directory, meaning you **do not** need to use API Routes and Route Handlers together.

## Convention

Route Handlers are defined in a [\`route.js|ts\` file](/docs/app/api-reference/file-conventions/route) inside the \`app\` directory:

\`\`\`ts filename="app/api/route.ts" switcher
export async function GET(request: Request) {}
\`\`\`

\`\`\`js filename="app/api/route.js" switcher
export async function GET(request) {}
\`\`\`

Route Handlers can be nested anywhere inside the \`app\` directory, similar to \`page.js\` and \`layout.js\`. But there **cannot** be a \`route.js\` file at the same route segment level as \`page.js\`.

## Supported HTTP Methods

The following [HTTP methods](https://developer.mozilla.org/docs/Web/HTTP/Methods) are supported: \`GET\`, \`POST\`, \`PUT\`, \`PATCH\`, \`DELETE\`, \`HEAD\`, and \`OPTIONS\`. If an unsupported method is called, Next.js will return a \`405 Method Not Allowed\` response.

## Extended \`NextRequest\` and \`NextResponse\` APIs

In addition to supporting the native Request and Response APIs, Next.js extends them with [\`NextRequest\`](/docs/app/api-reference/functions/next-request) and [\`NextResponse\`](/docs/app/api-reference/functions/next-response) to provide convenient helpers for advanced use cases.

## Reading request data

Inside a handler you can read the incoming request's cookies with [\`cookies\`](/docs/app/api-reference/functions/cookies) and its headers with [\`headers\`](/docs/app/api-reference/functions/headers), both imported from \`next/headers\`.

## Revalidating cached data

A \`POST\` handler can call [\`revalidateTag\`](/docs/app/api-reference/functions/revalidateTag) to purge tagged data on demand, for example from a CMS webhook:

\`\`\`bash filename="Terminal"
# Purge every cached entry tagged "posts"
curl -X POST "http://localhost:3000/api/revalidate?tag=posts"
\`\`\`
`,

  [FIXTURE_PATHS.link]: `---
title: Link Component
description: Enable fast client-side navigation with the built-in \`next/link\` component.
---

{/* The content of this doc is shared between the app and pages router. You can use the \`<PagesOnly>Content</PagesOnly>\` component to add content that is specific to the Pages Router. Any shared content should not be wrapped in a component. */}

\`<Link>\` is a React component that extends the HTML \`<a>\` element to provide prefetching and client-side navigation between routes. It is the primary way to navigate between routes in Next.js.

<AppOnly>

\`\`\`tsx filename="app/page.tsx" switcher
import Link from 'next/link'

export default function Page() {
  return <Link href="/dashboard">Dashboard</Link>
}
\`\`\`

\`\`\`jsx filename="app/page.js" switcher
import Link from 'next/link'

export default function Page() {
  return <Link href="/dashboard">Dashboard</Link>
}
\`\`\`

</AppOnly>

<PagesOnly>

\`\`\`tsx filename="pages/index.tsx" switcher
import Link from 'next/link'

export default function Home() {
  return <Link href="/blog/hello-world">Blog Post</Link>
}
\`\`\`

\`\`\`jsx filename="pages/index.js" switcher
import Link from 'next/link'

export default function Home() {
  return <Link href="/blog/hello-world">Blog Post</Link>
}
\`\`\`

</PagesOnly>

## Reference

The following props can be passed to the \`<Link>\` component:

| Prop       | Example             | Type             | Required |
| ---------- | ------------------- | ---------------- | -------- |
| \`href\`     | \`href="/dashboard"\` | String or Object | Yes      |
| \`replace\`  | \`replace={false}\`   | Boolean          | -        |
| \`scroll\`   | \`scroll={false}\`    | Boolean          | -        |
| \`prefetch\` | \`prefetch={false}\`  | Boolean or null  | -        |

## Prefetching

<AppOnly>

Prefetching happens when a \`<Link />\` component enters the user's viewport. Pair it with the \`useLinkStatus\` hook to show a pending indicator while a slow navigation is in flight.

</AppOnly>

<PagesOnly>

Prefetching happens when a \`<Link />\` component enters the user's viewport. In the Pages Router it also prefetches the JSON payload of pages that use [\`getStaticProps\`](/docs/pages/building-your-application/data-fetching/get-static-props).

</PagesOnly>
`,

  [FIXTURE_PATHS.cookies]: `---
title: cookies
description: API Reference for the cookies function.
---

\`cookies\` is an **async** function that allows you to read the HTTP incoming request cookies in [Server Components](/docs/app/getting-started/server-and-client-components), and read/write outgoing request cookies in [Server Functions](/docs/app/getting-started/updating-data) or [Route Handlers](/docs/app/api-reference/file-conventions/route).

\`\`\`tsx filename="app/page.tsx" switcher
import { cookies } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const theme = cookieStore.get('theme')
  return '...'
}
\`\`\`

\`\`\`jsx filename="app/page.js" switcher
import { cookies } from 'next/headers'

export default async function Page() {
  const cookieStore = await cookies()
  const theme = cookieStore.get('theme')
  return '...'
}
\`\`\`

## Reference

The following methods are available on the cookie store:

| Method                      | Return Type      | Description                                                        |
| --------------------------- | ---------------- | ------------------------------------------------------------------ |
| \`get('name')\`               | Object           | Accepts a cookie name and returns an object with the name and value. |
| \`getAll()\`                  | Array of objects | Returns a list of all the cookies with a matching name.            |
| \`has('name')\`               | Boolean          | Accepts a cookie name and returns whether the cookie exists.       |
| \`set(name, value, options)\` | -                | Accepts a cookie name, value, and options and writes the outgoing request cookie. |
| \`delete(name)\`              | -                | Accepts a cookie name and deletes the cookie.                      |

## Good to know

- \`cookies\` is an **asynchronous** function that returns a promise. You must use \`async/await\` or React's [\`use\`](https://react.dev/reference/react/use) function to access cookies.
- \`cookies\` is a [Request-time API](/docs/app/getting-started/partial-prerendering#dynamic-rendering) whose returned values cannot be known ahead of time. Using it in a layout or page will opt a route into dynamic rendering.
- The \`.delete\` method can only be called in a Server Function or Route Handler.

## Setting a cookie

You can use the \`(await cookies()).set(name, value, options)\` method in a [Server Function](/docs/app/getting-started/updating-data) or [Route Handler](/docs/app/api-reference/file-conventions/route) to set a cookie.

\`\`\`ts filename="app/actions.ts" switcher
'use server'

import { cookies } from 'next/headers'

export async function create(data: FormData) {
  const cookieStore = await cookies()
  cookieStore.set('name', 'lee', { secure: true })
}
\`\`\`

\`\`\`js filename="app/actions.js" switcher
'use server'

import { cookies } from 'next/headers'

export async function create(data) {
  const cookieStore = await cookies()
  cookieStore.set('name', 'lee', { secure: true })
}
\`\`\`

## Version History

| Version      | Changes                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| \`v15.0.0-RC\` | \`cookies\` is now an async function. A [codemod](/docs/app/guides/upgrading/codemods) is available. |
| \`v13.0.0\`    | \`cookies\` introduced.                                                                    |
`,

  [FIXTURE_PATHS.fetch]: `---
title: fetch
description: API reference for the extended fetch function.
---

Next.js extends the [Web \`fetch()\` API](https://developer.mozilla.org/docs/Web/API/Fetch_API) to allow each request on the server to set its own persistent caching and revalidation semantics.

In the browser, the \`cache\` option indicates how a fetch request will interact with the _browser's_ HTTP cache. With this extension, \`cache\` indicates how a _server-side_ fetch request will interact with the framework's persistent [Data Cache](/docs/app/guides/caching#data-cache).

You can call \`fetch\` with \`async\` and \`await\` directly within Server Components.

\`\`\`tsx filename="app/page.tsx" switcher
export default async function Page() {
  const data = await fetch('https://api.vercel.app/blog')
  const posts = await data.json()
  return <ul>{posts.map((post) => <li key={post.id}>{post.title}</li>)}</ul>
}
\`\`\`

\`\`\`jsx filename="app/page.js" switcher
export default async function Page() {
  const data = await fetch('https://api.vercel.app/blog')
  const posts = await data.json()
  return <ul>{posts.map((post) => <li key={post.id}>{post.title}</li>)}</ul>
}
\`\`\`

## \`fetch(url, options)\`

Since Next.js extends the Web \`fetch()\` API, you can pass any of the [native options available](https://developer.mozilla.org/docs/Web/API/fetch#parameters).

### \`options.cache\`

Configure how the request should interact with the Next.js Data Cache.

\`\`\`ts
fetch(\`https://...\`, { cache: 'force-cache' | 'no-store' })
\`\`\`

- **\`no-store\`**: Next.js fetches the resource from the remote server on every request.
- **\`force-cache\`**: Next.js looks for a matching request in its Data Cache before fetching.

### \`options.next.revalidate\`

\`\`\`ts
fetch(\`https://...\`, { next: { revalidate: false | 0 | number } })
\`\`\`

Set the cache lifetime of a resource, in seconds.

### \`options.next.tags\`

\`\`\`ts
fetch(\`https://...\`, { next: { tags: ['collection'] } })
\`\`\`

Set the cache tags of a resource. Data can then be revalidated on-demand using [\`revalidateTag\`](/docs/app/api-reference/functions/revalidateTag).

## Version History

| Version   | Changes             |
| --------- | ------------------- |
| \`v13.0.0\` | \`fetch\` introduced. |
`,

  [FIXTURE_PATHS.revalidateTag]: `---
title: revalidateTag
description: API Reference for the revalidateTag function.
---

\`revalidateTag\` allows you to invalidate [cached data](/docs/app/guides/caching) on-demand for a specific cache tag.

## Usage

\`revalidateTag\` can be called in Server Functions and Route Handlers. It cannot be called in Client Components, as it only works in server environments.

## Parameters

\`\`\`ts
revalidateTag(tag: string, profile: string | { expire?: number }): void;
\`\`\`

- \`tag\`: A string representing the cache tag associated with the data you want to revalidate. Must not exceed 256 characters. This value is case-sensitive.
- \`profile\`: A string that specifies the revalidation behavior. The recommended value is \`"max"\`, which provides stale-while-revalidate semantics.

## Examples

The following example invalidates every cached entry tagged \`posts\` after a new post is published:

\`\`\`ts filename="app/actions.ts" switcher
'use server'

import { revalidateTag } from 'next/cache'

export default async function submit() {
  await addPost()
  revalidateTag('posts', 'max')
}
\`\`\`

\`\`\`js filename="app/actions.js" switcher
'use server'

import { revalidateTag } from 'next/cache'

export default async function submit() {
  await addPost()
  revalidateTag('posts', 'max')
}
\`\`\`
`,

  [FIXTURE_PATHS.getStaticProps]: `---
title: getStaticProps
description: Fetch data and generate static pages with \`getStaticProps\`.
---

If you export a function called \`getStaticProps\` (Static Site Generation) from a page, Next.js will pre-render this page at build time using the props returned by \`getStaticProps\`.

\`\`\`tsx filename="pages/index.tsx" switcher
import type { InferGetStaticPropsType, GetStaticProps } from 'next'

export const getStaticProps = (async () => {
  const res = await fetch('https://api.github.com/repos/vercel/next.js')
  const repo = await res.json()
  return { props: { repo } }
}) satisfies GetStaticProps<{ repo: { stargazers_count: number } }>

export default function Page({ repo }: InferGetStaticPropsType<typeof getStaticProps>) {
  return repo.stargazers_count
}
\`\`\`

\`\`\`jsx filename="pages/index.js" switcher
export async function getStaticProps() {
  const res = await fetch('https://api.github.com/repos/vercel/next.js')
  const repo = await res.json()
  return { props: { repo } }
}

export default function Page({ repo }) {
  return repo.stargazers_count
}
\`\`\`

## When should I use getStaticProps?

You should use \`getStaticProps\` if the data required to render the page is available at build time, ahead of a user's request, and the page must be pre-rendered for SEO and be very fast.

## Where can I use getStaticProps

\`getStaticProps\` can only be exported from a **page**. You cannot export it from non-page files, \`_app\`, \`_document\`, or \`_error\`.
`,

  [FIXTURE_PATHS.pagesLink]: `---
title: Link
description: API reference for the \`<Link>\` component.
source: app/api-reference/components/link
---

{/* DO NOT EDIT. The content of this doc is generated from the source above. To edit the content of this page, navigate to the source page in your editor. You can use the \`<PagesOnly>Content</PagesOnly>\` component to add content that is specific to the Pages Router. Any shared content should not be wrapped in a component. */}
`,
};

/** The commit a fixture corpus claims to have been synced at. */
export function fixtureCommit(docsLine: string): string {
  return `fixture-${docsLine}`;
}

/** Writes a fixture corpus into `<harness>/manuals/nextjs-<line>/`. */
export async function writeFixtureManuals(
  root: string,
  docsLine: string,
  docs: Record<string, string> = FIXTURE_DOCS,
): Promise<string> {
  const paths = harnessPaths(root);
  const manualDir = paths.manualDir(docsLine);

  for (const [relative, content] of Object.entries(docs)) {
    const target = path.join(manualDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  const meta: ManualMeta = {
    framework: 'nextjs',
    version: docsLine,
    docsLine,
    lang: 'en',
    source: `https://github.com/vercel/next.js/tree/${docsLine}/docs`,
    branch: docsLine,
    commit: fixtureCommit(docsLine),
    treeSha: `fixture-tree-${docsLine}`,
    syncedAt: new Date().toISOString(),
    fileCount: Object.keys(docs).length,
  };
  await writeFile(paths.manualMetaFile(docsLine), JSON.stringify(meta, null, 2));

  return manualDir;
}

export interface IndexedProject {
  root: string;
  docsLine: string;
}

/**
 * Full offline setup: project + config + fixture manuals + built index.
 * `versions` may list several lines to test version isolation.
 */
export async function makeIndexedProject(
  options: {
    constraint?: string;
    lockVersion?: string;
    versions?: string[];
    docs?: Record<string, string>;
    /** Also embeds every chunk — pass makeFakeEmbeddingProvider() for hybrid tests. */
    embeddings?: EmbeddingProvider;
  } = {},
): Promise<IndexedProject> {
  const constraint = options.constraint ?? '^16.1.0';
  const root = await makeProject({ constraint, lockVersion: options.lockVersion });

  const major = Number(/(\d+)/.exec(constraint)![1]);
  const minor = /\d+\.(\d+)/.exec(constraint)?.[1];
  const version = buildVersion(
    { major, minor: minor ? Number(minor) : undefined },
    'package.json',
  );

  await ensureConfig(root, version);

  const paths = harnessPaths(root);
  const lines = options.versions ?? [version.docsLine];

  const repository = ManualRepository.open(paths.indexFile);
  try {
    for (const line of lines) {
      await writeFixtureManuals(root, line, options.docs);
      await indexManuals({
        repository,
        manualDir: paths.manualDir(line),
        docsLine: line,
        lang: 'en',
        commit: fixtureCommit(line),
        embeddings: options.embeddings,
      });
    }
  } finally {
    repository.close();
  }

  return { root, docsLine: version.docsLine };
}
