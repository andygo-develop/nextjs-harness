---
name: nextjs
description: Development conventions, architecture and testing practices for Next.js applications. Use when writing, reviewing or refactoring Next.js code — App Router layouts and pages, Server and Client Components, routing, data fetching, caching, Server Actions, Route Handlers, proxy/middleware, or tests. Pairs with the Next.js documentation MCP server for verified framework APIs.
---

# Next.js Development

How to write Next.js code well. This skill holds **conventions and judgement**;
the authoritative **framework reference** lives in the documentation MCP server.
Keep those roles separate — do not guess at APIs that the MCP can confirm.

## Verify before you assert

The single most damaging failure mode in Next.js work is a confidently invented
or outdated API: `getServerSideProps` inside `app/`, a synchronous `cookies()`
call, a `fetch` assumed to be cached, a `middleware.ts` in a project that has
moved to `proxy.ts`. Next.js changes defaults between majors — `fetch` caching
flipped in 15, request APIs went async in 15 and lost their synchronous
fallback in 16 — and training data mixes the Pages Router, 13/14-era App
Router and current behaviour freely. That is exactly where stale memory bites.

**Consult the documentation MCP before writing code whenever:**

- you are unsure a function, hook, component prop or file convention exists;
- behaviour may be version-specific (caching defaults, async request APIs, proxy vs middleware);
- a `next.config` option's name, shape or placement (top level vs `experimental`) is uncertain;
- it is unclear whether code runs on the server, the client, or both;
- caching, revalidation or rendering mode (static, dynamic, streamed) is uncertain;
- you are about to describe framework behaviour to the user as fact.

Tools available:

| Tool | Use |
|---|---|
| `search_nextjs_manual` | Find documentation for a topic, file convention, function or component |
| `get_nextjs_manual` | Fetch a full document by `documentId` from a search hit |
| `search_nextjs_api` | Look up a specific function, hook, component or config option |

The MCP server is already scoped to **this project's Next.js version**. Results
it returns are correct for the version in use; your memory may not be.

> Prefer verified information from the Next.js Documentation MCP over assumptions or memory.
> Never invent functions, hooks, file conventions, config options or framework
> behaviour — look them up.

If the MCP reports that documentation is not synchronized, tell the user to run
`nextjs-harness manuals update` rather than falling back to guesswork.

## Project specs are separate

Some projects also index their own specs, ADRs and design notes. Use these for
application-specific requirements and expected behaviour, not for Next.js
framework facts.

| Tool | Use |
|---|---|
| `search_project_specs` | Find this project's own requirements, design notes and ADRs |
| `get_project_spec` | Fetch a full project spec by `documentId` from a search hit |

Search project specs when planning features, writing tests for business rules,
or checking whether a domain behaviour is already documented. Keep the corpora
distinct in your reasoning and reporting: Next.js manual results explain the
framework; project specs explain this application's intended behaviour.

## Architecture in one page

The App Router is a React framework where the file system is the router and
components render on the server unless marked otherwise. Request flow:

```
Request
  → next.config          (headers, redirects, rewrites — static, declarative)
  → proxy.ts             (middleware.ts before 16 — redirects, rewrites, optimistic checks)
  → Route matching       (app/ folders → segments: dynamic, groups, parallel, intercepted)
  → Layouts → page       (Server Components by default — async, read data directly)
  → Suspense boundaries  (loading.tsx / <Suspense> — stream what isn't ready)
  → Client Components    ('use client' leaves — hydrated, interactive, serializable props)
  → Server Actions       (mutations — a POST to the page; validate + authorize inside)
  → Route Handlers       (route.ts — HTTP endpoints for webhooks and external clients)
  → Data access layer    (server-only — queries, session checks, DTOs)
  → Caches               (per-render memoization, 'use cache' / fetch cache, prerendered output, client router cache)
```

Layer responsibilities:

- **Route segment** — a folder under `app/`; its special files (`layout`, `page`, `loading`, `error`, `not-found`, `route`) define what renders there. Keep them thin: compose, don't compute.
- **Layout** — UI shared by a subtree. Persists across navigations and does not re-render on them, so it is never the place for an auth check.
- **Page** — the route's entry point: awaits `params`/`searchParams`, calls the data layer, composes components.
- **Server Component** — the default. Async, may read data and secrets, ships no JavaScript.
- **Client Component** — `'use client'`: state, effects, event handlers, browser APIs. A bundle boundary, so keep it at the leaves.
- **Server Action** — a `'use server'` function for mutations; a public POST endpoint in disguise.
- **Route Handler** — `route.ts`: webhooks, third-party or mobile clients, non-HTML responses. Not something your own Server Components fetch.
- **Proxy** — `proxy.ts` (`middleware.ts` up to 15): runs before routing for redirects, rewrites, headers and cookie-level optimistic checks. Not an authorization layer.
- **Data access layer (DAL)** — `server-only` modules that query the database or APIs, verify the session and return minimal DTOs. The pattern the Next.js docs recommend for new apps.
- **Feature folder** — the directory unit holding one domain's components, actions, DAL and schemas, outside `app/`. Not a Next.js concept — this skill's vocabulary; see `references/architecture.md`.

Details: `references/architecture.md`. File conventions and navigation:
`references/routing.md`. Reads, mutations and streaming:
`references/data-fetching.md`. Cache layers and invalidation:
`references/caching.md`. Naming, layout and tooling:
`references/conventions.md`.

## Rules that matter most

1. **Server by default, `'use client'` at the leaves.** Everything a Client
   Component imports joins the browser bundle. Make the interactive island
   the client file and pass server-rendered content through it as
   `children`. See `references/architecture.md`.
2. **Every Server Action is a public endpoint.** Anyone can POST to it with
   any arguments. Authenticate, authorize (ownership, not just "signed in")
   and validate input with a schema inside each one. See
   `references/security.md`.
3. **Data access goes through a `server-only` DAL.** Queries, session checks
   and DTO shaping live in one layer; pages, actions and handlers call it —
   never the ORM from scattered components. See `references/data-fetching.md`.
4. **Never hand a raw record to a Client Component.** Props are serialized
   into the payload the browser receives. Pass a DTO holding exactly what the
   UI renders. See `references/security.md`.
5. **Authorize next to the data, not in proxy or layouts.** Proxy is an
   optimistic redirect layer and layouts do not re-run on navigation. The DAL
   checks on every read; every action re-checks on every write.
6. **Know the caching model before touching caching.** Which major is this,
   and is `cacheComponents` on? Cache explicitly, and pair every mutation
   with the matching invalidation (`updateTag`, `revalidateTag`,
   `revalidatePath`). See `references/caching.md`.
7. **Await request data low in the tree.** `params`, `searchParams`,
   `cookies()` and `headers()` are async (15+). Await them in the component
   that needs them, inside `<Suspense>`, not at the top of a layout that then
   blocks everything below it. See `references/data-fetching.md`.
8. **Test logic where it is testable.** DAL functions, Server Actions and
   Route Handlers are plain async functions — unit-test them directly.
   Client Components get React Testing Library; async Server Components and
   whole flows get Playwright against a production build. See
   `references/testing.md`.

## Next.js 16 traps

These are the mistakes most likely to come from stale memory. The project may
be on 14, 15 or 16 — check `next` in `package.json` first, and verify
version-sensitive claims with the MCP.

| Don't | Do |
|---|---|
| Read `params.slug`, `searchParams.q`, `cookies()` or `headers()` synchronously | `await` them — async since 15; the synchronous fallback is gone in 16 |
| Assume `fetch` is cached by default | Not since 15 — opt in with `cache: 'force-cache'`/`next.revalidate`, or `'use cache'` under Cache Components (14 *did* cache by default) |
| Add `middleware.ts` exporting `middleware` on 16 | `proxy.ts` exporting `proxy` (Node.js runtime only); `middleware` is deprecated — codemod `middleware-to-proxy` |
| Use `export const dynamic`/`revalidate`/`fetchCache` in a `cacheComponents` app | `'use cache'` + `cacheLife()` + `cacheTag()` (superseding `unstable_cache`), runtime data behind `<Suspense>` — those segment configs error under Cache Components |
| Call `revalidateTag(tag)` with one argument on 16 | `revalidateTag(tag, 'max')` for stale-while-revalidate, or `updateTag(tag)` in a Server Action for read-your-own-writes |
| Assume webpack is the bundler, or that a custom `webpack()` config applies, on 16 | Turbopack is the default for `dev` and `build` (no `--turbopack` flag needed); a custom webpack config fails the build unless you opt out with `--webpack` |
| Write `getServerSideProps`/`getStaticProps`/`getStaticPaths` in `app/` | Async Server Components, `generateStaticParams`, caching APIs — those functions are Pages Router only |
| Import `useRouter` from `next/router` in `app/` | `next/navigation` — `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `redirect`, `notFound` |
| Keep `next lint` in scripts on 16 | Run ESLint directly with the `eslint-config-next` flat config — `next lint` was removed |
| `useFormState` from `react-dom` | `useActionState` from `react` (React 19; Next 15+) |

Requirements also matter: Next.js 16 needs Node.js 20.9+ and TypeScript 5.1+,
and its App Router builds on React 19.2. Verify anything version-sensitive
before relying on it.

## References

Load these as needed — they are not all relevant to every task.

| File | Covers |
|---|---|
| `references/architecture.md` | Project structure, App vs Pages Router, Server/Client Components, composition, DAL, env/config, logging |
| `references/routing.md` | File conventions, dynamic segments, route groups, parallel & intercepting routes, proxy, redirects, navigation |
| `references/data-fetching.md` | Server Component reads, ORMs in a DAL, Server Actions & forms, mutations, streaming, client fetching |
| `references/caching.md` | Memoization, data and route caches, client router cache, revalidation, `'use cache'`, 14→15→16 differences |
| `references/testing.md` | Vitest/Jest + RTL, async Server Component limits, testing actions & handlers, Playwright, MSW, what to assert |
| `references/security.md` | Server Actions as endpoints, authz, validation, data exposure, `server-only`, env vars, CSP, CSRF, injection |
| `references/conventions.md` | Naming, directory layout, colocation, `src/`, path aliases, `'use client'` placement, ESLint, scripts |

## Working on a task

1. Check the Next.js major and the router in use (`app/`, `pages/`, or both),
   then decide which layer the change belongs in before writing code.
2. Look up uncertain framework APIs with the Next.js manual/API tools — do not
   guess.
3. Search project specs when requirements or business behaviour may already be
   documented.
4. Follow existing patterns in the project; match its structure, its data
   layer, its caching model and its style.
5. Add or update tests alongside the change.
6. Keep pages and actions thin and business logic testable in isolation from
   rendering.
