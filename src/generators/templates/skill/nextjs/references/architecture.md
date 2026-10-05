# Architecture

Verify specific signatures with `search_nextjs_manual` before relying on them.

## App Router or Pages Router

Check which router a project uses before writing anything: `app/` is the App
Router, `pages/` the Pages Router (either may sit under `src/`). Both can
coexist during a migration. This skill targets the App Router; inside
`pages/`, follow Pages Router conventions instead. Never port Pages idioms
into `app/`:

| Pages Router | App Router |
|---|---|
| `pages/_app.tsx`, `pages/_document.tsx` | Root `app/layout.tsx` — renders `<html>` and `<body>` |
| `getServerSideProps`, `getStaticProps` | An async Server Component that reads its data directly |
| `getStaticPaths` | `generateStaticParams` |
| `pages/api/*.ts` | `route.ts` Route Handlers |
| `next/router` | `next/navigation` |
| `next/head` | `metadata` export or `generateMetadata` |
| `pages/404.tsx`, `pages/_error.tsx` | `not-found.tsx`, `error.tsx`, `global-error.tsx` |

## Directory layout

Next.js is unopinionated about anything outside routing. This skill uses one
layout: `app/` holds routing and composition only, and domain code lives in
**feature folders** — one per business domain, the same way a backend would
group a module.

```
src/
├── app/                                 routing only — segments, special files, thin pages
│   ├── layout.tsx                       root layout: <html>, <body>, providers
│   ├── (marketing)/page.tsx             route group — no URL segment
│   ├── (app)/
│   │   ├── layout.tsx
│   │   └── orders/
│   │       ├── page.tsx                 awaits params, calls the DAL, composes
│   │       ├── loading.tsx
│   │       ├── error.tsx
│   │       ├── _components/             used by this route only
│   │       └── [orderId]/page.tsx
│   └── api/webhooks/stripe/route.ts     Route Handler for an external caller
├── features/
│   └── orders/                          one domain, end to end
│       ├── components/                  order-table.tsx (server), order-filters.tsx (client)
│       ├── actions.ts                   'use server' — mutations
│       ├── data.ts                      import 'server-only' — reads, session checks, DTOs
│       ├── schemas.ts                   zod schemas shared by form and action
│       └── types.ts
├── components/ui/                       design-system primitives, no domain knowledge
├── lib/                                 infrastructure: db client, session, logger, env
├── instrumentation.ts
└── proxy.ts                             middleware.ts before 16
```

Dependencies point one way: `app/` imports features, features import `lib/`
and `components/ui/`; `lib/` never imports a feature. If `lib/db.ts` starts
importing from `features/orders/`, business logic has leaked into
infrastructure — catch it in review, since the layout alone will not.

Some projects call feature folders `modules/` or keep everything under
`app/` with private `_folders`. Match what exists; do not introduce a second
scheme. Naming and colocation rules: `references/conventions.md`.

## Server and Client Components

Every component in `app/` is a Server Component unless its module (or one
that imports it) starts with `'use client'`.

| Needs | Component |
|---|---|
| Data access, secrets, heavy libraries (markdown, syntax highlighting) | Server |
| `useState`, `useEffect`, event handlers, context consumers | Client |
| Browser APIs — `window`, `localStorage`, `IntersectionObserver` | Client |

`'use client'` marks a **boundary in the module graph**: that file and
everything it imports ship to the browser. Client Components still render on
the server for the initial HTML, so touching `window` during render breaks
there too. Client Components cannot be `async`, and cannot import
server-only modules.

Props crossing from server to client must be serializable by React — plain
objects, arrays, primitives, `Date`, `Map`/`Set`, promises, JSX and Server
Actions; not class instances or ordinary functions. Verify edge cases with
the MCP. Serializable also means *visible*: see `references/security.md`.

## Composition

Push the boundary down. Make only the interactive piece a Client Component;
the page around it stays on the server:

```tsx
// app/(app)/orders/page.tsx — Server Component
import { getOrders } from '@/features/orders/data';
import { OrderFilters } from '@/features/orders/components/order-filters'; // 'use client'
import { OrderTable } from '@/features/orders/components/order-table';     // server

export default async function OrdersPage() {
  const orders = await getOrders();
  return (
    <>
      <OrderFilters />
      <OrderTable orders={orders} />
    </>
  );
}
```

Pass server-rendered content *through* a Client Component as `children` or
another prop — it stays a Server Component, because the server renders it
before the client wrapper ever sees it:

```tsx
<Drawer trigger="Cart">   {/* 'use client' — owns open/closed state */}
  <CartSummary />          {/* Server Component — reads the cart on the server */}
</Drawer>
```

Context providers are Client Components: wrap `{children}` in a
`providers.tsx` and render it as deep in the tree as it can go. A
third-party component that uses client features but lacks `'use client'`
gets a one-line wrapper file of your own that re-exports it under the
directive.

## Data access layer

All reads and writes go through `server-only` modules — per feature, in
`data.ts`. A DAL function verifies the session itself, queries, and returns
a DTO: the minimum the caller renders, never the raw row.

```ts
// features/orders/data.ts
import 'server-only';
import { cache } from 'react';
import { db } from '@/lib/db';
import { verifySession } from '@/lib/session';

export const getOrders = cache(async () => {
  const { userId } = await verifySession(); // redirects or throws when signed out
  const rows = await db.order.findMany({
    where: { customerId: userId },
    select: { id: true, status: true, total: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(toOrderSummary);
});
```

`cache()` deduplicates the call within one request, so a layout and a page
can both call `getOrders()` for one query. Because the session check lives
here, every caller gets it, whoever forgets. Patterns:
`references/data-fetching.md`; the security angle: `references/security.md`.

## Where logic belongs

| Concern | Home |
|---|---|
| Reading the URL, choosing what to render | `page.tsx` / `layout.tsx` |
| Reusable query, session check, DTO shaping | The feature's DAL (`data.ts`) |
| Shape of one input (required, format, length) | A zod schema in `schemas.ts`, shared by form and action |
| Rule needing the database (uniqueness, ownership) | DAL or action, before the write |
| Mutation triggered from the UI | Server Action (`actions.ts`) |
| Endpoint for an external caller (webhook, mobile app) | Route Handler |
| Redirect, rewrite or header before routing | Proxy, or `next.config` when static |
| Interactivity, browser APIs | Client Component |
| Work after the response is sent (audit, analytics) | `after()` — verify availability for the version |
| Startup hooks, tracing, server error reporting | `instrumentation.ts` |

## Configuration and environment

Framework settings live in `next.config.ts` (TypeScript config since 15).
Keep it declarative; check with the MCP whether an option is top level or
still under `experimental` — options graduate between majors.

Environment variables are server-only unless prefixed `NEXT_PUBLIC_`, which
inlines the value into the client bundle **at build time** — it is frozen
there, so one image promoted across environments carries the build's value.
Validate the environment once, in one typed module, instead of reading
`process.env` throughout domain code:

```ts
// lib/env.ts
import 'server-only';
import { z } from 'zod';

export const env = z.object({
  DATABASE_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
}).parse(process.env);
```

A missing variable then fails at startup, not mid-request. Public values
must be referenced literally (`process.env.NEXT_PUBLIC_APP_URL`) for
inlining to work — dynamic lookups are not inlined. `serverRuntimeConfig`
and `publicRuntimeConfig` were removed in 16. Tooling outside the Next.js
runtime (ORM CLIs, test setup) loads `.env*` files with `loadEnvConfig`
from `@next/env`.

## Logging and observability

Code in Server Components, actions and Route Handlers logs to the server
process; Client Components log to the browser console. Use a structured
logger in `lib/logger.ts` (marked `server-only`) rather than ad hoc
`console.log`; some logging libraries must be listed in
`serverExternalPackages` to stay out of the bundle — verify.

`instrumentation.ts` exports `register()`, run once per server instance
(OpenTelemetry setup), and `onRequestError` (15+) for reporting server
errors. In production, errors thrown in Server Components reach the client
as a generic message with a `digest`; log the full error server-side and
correlate by digest. Never log secrets, tokens, session cookies, raw form
payloads or personal data.
