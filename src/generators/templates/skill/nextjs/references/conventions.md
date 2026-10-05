# Conventions

Inside `app/`, names are the framework's API: special file names (`page`,
`layout`, `route`, …) and folder syntax (`[id]`, `(group)`, `@slot`,
`_private`) decide what is routable and how. Outside `app/`, Next.js has no
opinion — everything there is convention, and deviating costs
discoverability rather than working code.

## Files

| What | File | Export |
|---|---|---|
| Special files | `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `route.ts` — fixed lowercase names | Default export (Route Handlers: named `GET`, `POST`, …) |
| Route segments | kebab-case folders — they become URLs: `app/order-history/` | — |
| Component | `order-table.tsx` | `OrderTable` |
| Client Component | Same naming; `'use client'` is the first line | `OrderFilters` |
| Server Actions | `actions.ts` per feature (an `actions/` folder once large) | `createOrderAction` |
| Data access | `data.ts` per feature (a `data/` folder once large), `server-only` | `getOrders`, `createOrder` |
| Schemas | `schemas.ts` | `CreateOrderSchema` |
| Cache tags | `cache-tags.ts` | `catalogTags` |
| Hook | `use-debounced-value.ts` | `useDebouncedValue` |
| Types | `types.ts` per feature | `OrderSummary` |
| Unit / component test | `actions.test.ts`, `order-table.test.tsx` in the feature's `tests/` | — |
| End-to-end test | `e2e/checkout.spec.ts` | — |

kebab-case files with PascalCase component exports is this skill's default;
plenty of codebases use `OrderTable.tsx` instead. Either is fine applied
uniformly — match the project rather than mixing the two.

Outside special files, prefer named exports: they keep names consistent
across imports and make renames and searches reliable.

## Directory layout

The full tree, and the reasoning behind feature folders, is in
`references/architecture.md`. The rules that matter when adding files:

- `app/` holds routing and composition. A page that grows business logic is
  a page that should be calling a feature's DAL or action.
- Application code lives under `src/`; configuration (`next.config.ts`,
  `tsconfig.json`, `package.json`, `.env*`) and `public/` stay at the root.
  `proxy.ts` and `instrumentation.ts` go inside `src/` when it exists.
- If both `app/` and `src/app/` exist, the root `app/` wins and `src/app/` is
  ignored. Never create the second one.
- Infrastructure (`lib/`) never imports from a feature; features never
  import another feature's internals, only its DAL functions, actions and
  exported components.

## Colocation

Files inside `app/` are not routable unless named `page` or `route`, so
colocating is safe. Put route-specific pieces in a private folder —
`app/(app)/orders/_components/` — so they read as non-routes and cannot
collide with a future special file name. Promote code by its users:

| Used by | Lives in |
|---|---|
| One route | That route's `_components/` |
| Several routes of one domain | The feature folder |
| Any domain | `components/ui/` or `lib/` |

Move code when the second user appears, not in anticipation of one.

## `'use client'` and `'use server'`

- `'use client'` is the first line of the file, before imports, and only on
  files that need state, effects, event handlers, browser APIs or a
  client-only library. Not on pages or layouts — split the interactive part
  out instead.
- A module imported by a Client Component is already client code; adding
  the directive there too is noise.
- No barrel files (`index.ts` re-exports) that mix server and client
  modules — they drag code across the boundary and defeat tree-shaking.
  Import from the defining file, and never put `'use client'` on a barrel.
- `'use server'` files export only async functions — schemas, types and
  constants live in `schemas.ts` and `types.ts` beside them.

## Path aliases

`create-next-app` maps `@/*` to `./src/*` (or `./*` without `src/`), and
Next.js reads `paths` from `tsconfig.json` natively:

```ts
import { getOrders } from '@/features/orders/data';
import { Button } from '@/components/ui/button';
```

Use one alias for the whole tree. Test runners need telling separately —
`vite-tsconfig-paths` for Vitest, `moduleNameMapper` for Jest. Confirm what a
project already defines before adding an alias; two overlapping schemes are
worse than one.

## Types

- `PageProps<'/orders/[orderId]'>`, `LayoutProps` and `RouteContext` type
  `params` from the actual route tree — generated since 15.5 by
  `next typegen`, `next dev` and `next build`.
- `typedRoutes: true` type-checks `<Link href>` — stable in recent versions;
  verify for the project's.
- `next-env.d.ts` is generated; never edit it.
- Type Client Component props as narrow DTOs. A prop typed as the full
  database model invites passing the full model.

## Linting and formatting

`eslint-config-next` provides `eslint-config-next/core-web-vitals`
(recommended) and `eslint-config-next/typescript`. On 16 it defaults to flat
config and `next lint` no longer exists, so run ESLint directly:

```js
// eslint.config.mjs
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
```

Projects on 15 or earlier often use `next lint` with
`extends: ['next/core-web-vitals', 'next/typescript']` — keep whichever
setup the project has unless the task is migrating it. Formatting (Prettier,
Biome) and import order are project decisions; match the surrounding code.

## Scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:e2e": "playwright test"
  }
}
```

On 16, Turbopack is the default for `dev` and `build` (`--webpack` opts
out); on 15, `next dev --turbopack` was the opt-in. `next build` type-checks
by default, but a separate `typecheck` script gives faster feedback in CI.
Upgrades between majors have codemods (`npx @next/codemod`) — look up the
current command with the MCP rather than recalling one.

## When to break convention

Genuinely cross-cutting code (a design-system primitive, the logger, the
session helper) belongs in `components/ui/` or `lib/`, imported explicitly —
not duplicated per feature, and not moved there merely because two features
use it when it really belongs to one domain. Override the specific thing
that differs, where it differs; do not adopt a project-wide alternative
layout so a handful of legacy routes do not have to move.
