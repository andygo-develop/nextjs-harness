# Data fetching and mutations

Reads happen in Server Components, writes in Server Actions, and both go
through the data access layer. What gets *cached* is version-dependent —
see `references/caching.md` and verify with `search_nextjs_manual`.

## Reading in Server Components

Server Components are async; fetch where the data is used.

```tsx
// app/(app)/orders/page.tsx
import { getOrders } from '@/features/orders/data';
import { OrderTable } from '@/features/orders/components/order-table';

export default async function OrdersPage() {
  const orders = await getOrders();
  return <OrderTable orders={orders} />;
}
```

Never `fetch` your own Route Handlers from a Server Component: call the DAL
function the handler would call. The HTTP hop is pure overhead at request
time, and during a build-time prerender no server is listening, so it fails.

Within one render pass, identical `fetch` GETs are memoized automatically;
other reads — ORM calls, the session lookup — need React's `cache()` to get
the same deduplication, which is why DAL functions are wrapped in it.

## Avoiding waterfalls

Sequential `await`s fetch sequentially. Start independent reads together:

```tsx
const [orders, invoices] = await Promise.all([getOrders(), getOpenInvoices()]);
```

Better still, give each slow read its own component inside its own
`<Suspense>`, so fast parts render without waiting for slow ones.

## The database behind a DAL

Database clients are infrastructure in `lib/db.ts`; queries live in each
feature's `data.ts`. Both import `'server-only'`. In development, hot reload
re-evaluates modules, and a client created per evaluation exhausts the
connection pool — keep one instance on `globalThis`:

```ts
// lib/db.ts — Prisma shown; the singleton applies to any ORM
import 'server-only';
import { PrismaClient } from '@prisma/client'; // import path depends on the project's Prisma setup

const globalForDb = globalThis as unknown as { db?: PrismaClient };

export const db = globalForDb.db ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForDb.db = db;
```

Confirm which ORM the project uses (Prisma, Drizzle, Kysely, a raw driver)
before assuming its API. Whatever it is: select only the columns the caller
renders, paginate anything unbounded, load relations explicitly rather than
in a loop, and map rows to DTOs before they leave the DAL.

## Server Actions and forms

Put actions in a feature's `actions.ts` with `'use server'` at the top of the
file — every export becomes an action, and every export must be async. A
Client Component can import them but cannot define them. Inline `'use server'`
functions inside Server Components also work, but their closed-over
variables round-trip through the client; prefer module-level actions.

Every action follows the same shape — authenticate, validate, write through
the DAL, invalidate, then navigate:

```ts
// features/orders/actions.ts
'use server';

import { updateTag } from 'next/cache'; // 16; on 15 use revalidateTag(tag) or revalidatePath
import { redirect } from 'next/navigation';
import { verifySession } from '@/lib/session';
import { createOrder } from './data';
import { CreateOrderSchema } from './schemas';

export type CreateOrderState = { errors?: Record<string, string[] | undefined> };

export async function createOrderAction(
  _previous: CreateOrderState,
  formData: FormData,
): Promise<CreateOrderState> {
  const { userId } = await verifySession();
  const parsed = CreateOrderSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  const order = await createOrder(userId, parsed.data); // owner from the session, never the form
  updateTag(`orders:${userId}`);
  redirect(`/orders/${order.id}`); // throws — keep it outside any try/catch
}
```

The form binds it with `useActionState` (React 19; `useFormState` before):

```tsx
'use client';

import { useActionState } from 'react';
import { createOrderAction } from '../actions';

export function CreateOrderForm() {
  const [state, formAction, pending] = useActionState(createOrderAction, {});
  return (
    <form action={formAction}>
      <input name="sku" required />
      <input name="quantity" type="number" min={1} />
      {state.errors?.quantity && <p role="alert">{state.errors.quantity[0]}</p>}
      <button disabled={pending}>Place order</button>
    </form>
  );
}
```

- **Expected errors are return values**, rendered by the form; throw only
  for the unexpected, which `error.tsx` catches.
- **Return values are sent to the browser** — keep them small and free of
  internals.
- **Extra arguments** via `action.bind(null, id)` or hidden inputs come back
  from the client and can be tampered with. Re-check them like form fields.
- **Pending and optimistic UI**: `useFormStatus` (from `react-dom`) inside the
  form, `useOptimistic` for optimistic updates, `useTransition` when calling
  an action from an event handler instead of a form.
- **Not for reads.** Actions are POST requests, dispatched one at a time per
  client, and never cached. Fetch for rendering in Server Components, or
  through a Route Handler for client-side libraries.

Authorization and validation are mandatory in every action:
`references/security.md`.

## After a mutation

| Goal | Call in the action |
|---|---|
| The user must see their own change immediately (16) | `updateTag(tag)` |
| Content may be briefly stale (catalog, posts) | `revalidateTag(tag, 'max')` on 16; `revalidateTag(tag)` before |
| One route's output changed and nothing is tagged | `revalidatePath('/orders')` |
| Re-render the current view without touching caches (16) | `refresh()` from `next/cache` |
| Send the user elsewhere | `redirect()`, after invalidating |

Details, and the rules for choosing tags: `references/caching.md`.

## Streaming and Suspense

`loading.tsx` is a segment-level Suspense boundary; `<Suspense>` places one
around any component. Put boundaries around slow reads and around anything
that reads request data (`cookies()`, `headers()`, `searchParams`) — under
Cache Components, such reads outside a boundary are flagged as blocking the
route.

Push `await`s down. Instead of awaiting in a layout or page, pass the
promise to the component that needs the value and await it there, inside
its boundary. The same works across the client boundary — start the read on
the server and let a Client Component unwrap it with `use()`:

```tsx
// Server Component — starts the read, does not block on it
const reviews = getReviews(productId);
return (
  <Suspense fallback={<ReviewsSkeleton />}>
    <Reviews reviews={reviews} />
  </Suspense>
);
```

```tsx
'use client';

import { use } from 'react';

export function Reviews({ reviews }: { reviews: Promise<Review[]> }) {
  const items = use(reviews);
  return <ul>{items.map((review) => <li key={review.id}>{review.body}</li>)}</ul>;
}
```

Design fallbacks with the final layout's dimensions to avoid layout shift.

## Client-side fetching

Default to reading on the server and passing data down. If a Client
Component needs server data once, pass a promise and `use()` it — no library
required. Reach for SWR or TanStack Query when the browser needs its own
cache: polling, revalidate-on-focus, infinite scroll, search-as-you-type,
optimistic updates shared across components.

- Seed the first render from the server — SWR's `fallback` option on
  `SWRConfig`, TanStack Query's `HydrationBoundary` — rather than showing a
  spinner for data the server already had.
- Client fetchers call Route Handlers (`GET`, cacheable), not Server Actions.
- After a mutation, invalidate both the library's key and any server cache
  tag that supplied the initial data, or they drift apart.
- Do not `useEffect`-fetch what a Server Component could have read.

Confirm which library (if any) the project already uses, and its major
version, before writing against its API.
