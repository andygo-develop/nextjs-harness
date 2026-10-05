# Testing

Next.js ships no test runner. Most projects pair Vitest or Jest (with React
Testing Library) for unit and component tests with Playwright or Cypress for
end-to-end. Check `package.json` for which this project uses, and for its
script names (`test`, `test:e2e`), before adding anything.

## Layout

```
src/features/orders/
├── actions.ts
├── data.ts
├── components/
│   └── create-order-form.tsx
└── tests/
    ├── actions.test.ts                      Server Actions, called directly
    ├── data.test.ts                         DAL functions
    └── components/
        └── create-order-form.test.tsx       Client Component, RTL
e2e/
└── orders.spec.ts                           Playwright, against a production build
```

Each feature folder owns a `tests/` folder mirroring its own structure;
end-to-end specs live in a top-level `e2e/`, since a user journey crosses
features. Test files inside `app/` are not routable, so a Route Handler's
test may sit beside it as `route.test.ts`. If the project already colocates
`*.test.tsx` next to sources, or uses `__tests__/`, match that instead of
adding a second convention.

## Runner setup notes

- **Vitest**: `@vitejs/plugin-react`, `jsdom` and `vite-tsconfig-paths` (for
  the `@/` alias). Use `jsdom` for components and the `node` environment for
  DAL, actions and handlers — per file (`// @vitest-environment node`) or
  per project.
- **Jest**: `next/jest` loads `next.config` and `.env` files and configures
  SWC transforms and asset mocks; path aliases still need `moduleNameMapper`.
- **`server-only`** throws when imported outside a React Server environment,
  which includes a plain test runner. Mock it in setup —
  `vi.mock('server-only', () => ({}))` — or alias it to an empty module.
- **Env**: in the test environment `.env.test` is loaded and `.env.local`
  is not. Outside Next's own loaders, call `loadEnvConfig` from `@next/env`
  in setup.

## Client Components

Render, interact through `@testing-library/user-event`, and assert on what a
user perceives — roles, labels, text. Hooks from `next/navigation` need the
App Router context, so mock them:

```tsx
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/orders',
  useSearchParams: () => new URLSearchParams('status=open'),
}));
```

For a form driven by `useActionState`, mock the actions module and assert the
rendered states — field errors from the returned state, the disabled button
while pending — not the action's internals.

## Server Components

Synchronous Server Components render with RTL like any component. **Async
Server Components are not supported** by Vitest, Jest or Cypress component
testing — the Next.js docs recommend end-to-end tests for them. A pragmatic
escape hatch for a leaf page is to await the component as a function:

```tsx
vi.mock('@/features/orders/data');

it('renders the order heading', async () => {
  vi.mocked(getOrder).mockResolvedValue(anOrderSummary({ id: 'o_1' }));

  render(await OrderPage({ params: Promise.resolve({ orderId: 'o_1' }) }));

  expect(screen.getByRole('heading', { name: /order o_1/i })).toBeInTheDocument();
});
```

This breaks as soon as an async component sits below the one you awaited,
and it never exercises Suspense or streaming. The durable answer is
structural: keep pages thin, unit-test the DAL they call, and cover the page
end to end.

## Server Actions

Actions are async functions — call them the way an attacker would, with a
`FormData` and no UI. Mock the framework and the boundaries around them:

```ts
vi.mock('next/cache', () => ({ updateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/session', () => ({ verifySession: vi.fn() }));
vi.mock('../data', () => ({ createOrder: vi.fn() }));

it('rejects an invalid quantity without writing', async () => {
  vi.mocked(verifySession).mockResolvedValue({ userId: 'u_1' });
  const form = new FormData();
  form.set('sku', 'SKU-1');
  form.set('quantity', '0');

  const state = await createOrderAction({}, form);

  expect(state.errors?.quantity).toBeDefined();
  expect(createOrder).not.toHaveBeenCalled();
});
```

The real `redirect()` and `notFound()` work by throwing; mock them, as
above, or assert the throw. Always cover the refusal paths: no session, and
a session that does not own the target resource.

## Route Handlers

Import the exported method and call it with a standard `Request`:

```ts
import { POST } from '@/app/api/webhooks/stripe/route';

it('rejects a webhook without a valid signature', async () => {
  const request = new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    body: JSON.stringify({ type: 'checkout.session.completed' }),
  });

  const response = await POST(request);

  expect(response.status).toBe(400);
});
```

Handlers for dynamic segments take a second argument —
`{ params: Promise.resolve({ id: '1' }) }` on 15+. Use `NextRequest` when the
handler reads `nextUrl` or `cookies`. For proxy, `next/experimental/testing/server`
(15.1+) offers matcher and rewrite helpers whose names follow the
middleware→proxy rename — verify them with the MCP.

## End-to-end tests

Run Playwright against a **production build**. Dev mode compiles on demand
and caches differently, so it hides exactly the prerendering and caching
bugs end-to-end tests exist to catch:

```ts
// playwright.config.ts
webServer: {
  command: 'npm run build && npm run start',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
},
```

This is the right level for async Server Components, streaming, proxy
redirects, auth flows, and "the change shows up after the mutation". Seed a
dedicated test database and keep specs independent of run order. Cypress
works too; confirm which one the project has.

## Mocking the network

- **MSW** (`setupServer` from `msw/node`) in unit tests intercepts `fetch`
  from code under test, whether it runs as a Client Component in `jsdom` or
  as a DAL function in `node`.
- **In end-to-end tests**, browser-level interception — Playwright's
  `page.route`, MSW's service worker — sees only requests the browser makes.
  Server Components fetch on the server: point the app at a stub service via
  environment variables, or look into Next's experimental test mode for
  Playwright (verify).
- Mock at the boundary — HTTP or the DAL module — never the component or
  action under test.

## What to test

- Every Server Action refuses unauthenticated callers and resources the
  caller does not own — called directly, not through the form.
- Invalid input returns errors and writes nothing; undeclared fields never
  reach the database.
- DAL functions return DTOs — assert that sensitive fields (`passwordHash`,
  internal ids) are absent, not merely that the expected ones are present.
- Mutations invalidate what they change — assert `updateTag`/
  `revalidateTag`/`revalidatePath` was called with the expected tag or path.
- Route Handlers: status codes, webhook signature checks, unsupported
  methods.
- Client Components: empty, error and pending states as well as the happy
  path.
- End to end: critical journeys, redirects for signed-out users, not-found
  pages.
- Anything that has broken before.

Not worth testing: that a folder becomes a route, that `<Link>` navigates,
that React renders. Test behaviour, not implementation — assert on rendered
output and returned state, not on which hooks ran or the exact query an ORM
issued.
