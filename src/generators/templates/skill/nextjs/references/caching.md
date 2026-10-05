# Caching

Caching is where Next.js versions differ most, and where stale memory does
the most damage. Establish two facts before changing anything: the `next`
major in `package.json`, and whether `next.config` sets
`cacheComponents: true`. Then confirm specifics with `search_nextjs_manual` —
this file is a map, not the API reference.

## Two models

| | Previous model (14, 15, and 16 without the flag) | Cache Components (16 with `cacheComponents: true`) |
|---|---|---|
| A route by default | Static, unless it uses request-time APIs or opts out | Dynamic; a static shell is prerendered from whatever can complete |
| Cache a `fetch` | `cache: 'force-cache'` or `next: { revalidate, tags }` | Call it inside a `'use cache'` scope |
| Cache a database read | `unstable_cache()` | `'use cache'` with `cacheLife()` and `cacheTag()` |
| Route-level control | `export const dynamic`, `revalidate`, `fetchCache` | Not allowed — they error; use `cacheLife()` and `<Suspense>` |
| Reading `cookies()`/`headers()` | Makes the whole route dynamic | Streams in its own `<Suspense>` boundary; the rest stays in the shell |

Do not mix them casually. Segment configs error under Cache Components, and
`'use cache'` requires the flag. Under Cache Components, `'use cache'`
supersedes `unstable_cache` — keep the latter (or the `fetch` cache) only
where an entry must survive a deployment, which `'use cache'` entries do not. Migrating is a
project decision, not a side effect of another task.

## The layers

Name the layer before debugging staleness:

1. **Request memoization** — one server render pass. Identical `fetch` GETs
   are deduplicated automatically; wrap other reads in React `cache()`.
   Nothing to invalidate; not applied in Route Handlers.
2. **Server data cache** — `fetch` results and `unstable_cache` entries
   persist across requests and even deployments. `'use cache'` entries are
   in-memory per instance by default and scoped to one deployment —
   serverless instances may not reuse them; `'use cache: remote'` or
   `cacheHandlers` provide shared storage. Invalidated by time or tag.
3. **Prerendered output** — HTML and RSC payload produced at build time or
   by revalidation (ISR, or the static shell under Cache Components), reused
   for every request until revalidated.
4. **Client router cache** — RSC payloads of visited and prefetched
   segments, in browser memory for the session. Refreshed by
   `router.refresh()` and by invalidation inside a Server Action.

"Stale after a mutation": check that the action invalidates, with the right
tag or path, and that the reader carries that tag. "Fine in dev, stale in
production": the route was prerendered at build time — read the
`next build` route table.

## Static, dynamic, streamed

**Previous model.** A route is prerendered at build time unless something
makes it dynamic: a request-time API (`cookies()`, `headers()`,
`searchParams`, `connection()`), a `fetch` with `cache: 'no-store'`, or
`dynamic = 'force-dynamic'`. The trap since 15: a `fetch` with *no* cache
option, in a route with no request-time APIs, runs once during
`next build` — its result is frozen into the page until revalidated.

**Cache Components.** Nothing is cached unless you say so. The build
prerenders a static shell from static JSX, `'use cache'` results and
module-level data, plus `<Suspense>` fallbacks for the rest (Partial
Prerendering). Uncached reads or runtime APIs outside `<Suspense>` surface
as errors or dev-overlay insights; values like `Date.now()` or
`Math.random()` in the prerendered part need `connection()` inside a
boundary, or a `'use cache'` scope. `instant = false` defers validation per
segment during migration — verify.

## `'use cache'`

```ts
// features/catalog/data.ts
import 'server-only';
import { cacheLife, cacheTag } from 'next/cache';
import { db } from '@/lib/db';
import { catalogTags } from './cache-tags';

export async function getProduct(slug: string) {
  'use cache';
  cacheLife('hours');
  cacheTag(catalogTags.all, catalogTags.product(slug));
  return db.product.findUnique({ where: { slug }, select: productCardFields });
}
```

- Placed first in an async function or component body, or at the top of a
  file to cache every export.
- Arguments and closed-over values form the cache key, so they must be
  serializable. Pass ids, not request objects.
- `cookies()`, `headers()` and `searchParams` are forbidden inside — even in
  helpers it calls. Read them outside and pass the values in.
  `'use cache: private'` exists for rare per-user cases; verify first.
- Pair every scope with `cacheLife` — built-in profiles (`minutes`, `hours`,
  `days`, `max`, …) or custom ones in `next.config`; check the list with the
  MCP.
- **Authorize outside the cache.** A check inside a cached function runs
  once per key, not once per caller. Check the session first, then call a
  cached function whose key includes whatever scopes the data.
- React `cache()` does not cross into a `'use cache'` scope; pass data as
  arguments.

## Previous model: `fetch` options and `unstable_cache`

```ts
const res = await fetch(`${API_URL}/products`, {
  next: { revalidate: 3600, tags: ['products'] },
});

export const getProduct = unstable_cache(
  async (slug: string) => db.product.findUnique({ where: { slug } }),
  ['product'],
  { revalidate: 3600, tags: ['products'] },
);
```

Segment configs — `export const revalidate = 3600`,
`export const dynamic = 'force-dynamic'` — act on a whole route; prefer
caching the specific read. On 14, `fetch` was cached by default, so code
written for it caches more than a reader on 15 expects.

## Invalidation

| API | Use when | Callable from |
|---|---|---|
| `updateTag(tag)` | The user must see their own write in the response (16) | Server Actions only |
| `revalidateTag(tag, profile)` | Readers may see stale data briefly while it refreshes | Server Actions, Route Handlers |
| `revalidatePath(path, type?)` | One route changed and its data is not tagged | Server Actions, Route Handlers |
| `refresh()` | Re-render the current route without touching caches (16) | Server Actions |
| `router.refresh()` | Re-fetch the current route from the client | Client Components |

On 16, `revalidateTag` needs its second argument — `'max'` for
stale-while-revalidate; the one-argument form is deprecated. A webhook in a
Route Handler cannot call `updateTag`; `revalidateTag(tag, { expire: 0 })`
expires immediately. A dynamic path pattern needs its type:
`revalidatePath('/products/[slug]', 'page')`. None of these work in Client
Components or proxy, and none may run during render.

Tag by entity and by collection, and keep tag names in one module so readers
and writers cannot drift:

```ts
// features/catalog/cache-tags.ts
export const catalogTags = {
  all: 'products',
  product: (slug: string) => `product:${slug}`,
};
```

Every write path — actions, webhooks, admin scripts — must invalidate every
tag the changed data was cached under. A missed path is a staleness bug
that only shows in production.

## Version differences

| Behaviour | 14 | 15 | 16 |
|---|---|---|---|
| `fetch` default | Cached | Not cached (still fetched once at build in a static route) | As 15; `'use cache'` under Cache Components |
| `GET` Route Handlers | Static unless dynamic APIs are used | Not cached; `dynamic = 'force-static'` opts in | As 15; prerendered like pages under Cache Components |
| Client router cache for pages | Reused ~30 s (dynamic) / 5 min (static) | Not reused by default (`staleTimes` opts in); layouts and back/forward still are | Prefetching reworked; `cacheLife` `stale` applies under Cache Components |
| `cookies()`, `headers()`, `params` | Synchronous | Async, sync access deprecated | Async only |
| `'use cache'`, `cacheLife`, `cacheTag` | — | Experimental flags, `unstable_` imports | Stable behind `cacheComponents` |
| Invalidation | `revalidateTag(tag)`, `revalidatePath` | Same | `revalidateTag(tag, profile)`; `updateTag` and `refresh` added |
| Partial Prerendering | Experimental | Experimental | Part of Cache Components |

Minor versions move these lines too (`staleTimes`, prefetching, cache
handlers). When a cell matters for the task, confirm it for the project's
exact version with the MCP.
