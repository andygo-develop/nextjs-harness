# Security

## Server Actions are public endpoints

Any Server Action that client code can reach gets an ID and can be invoked
by a direct POST, with any arguments, by anyone — not only through the form
that renders it. Next.js encrypts action IDs, rotates them between builds
and drops unused actions from the bundle; that is obscurity, not access
control. Inside **every** action:

```ts
'use server';

export async function archiveProject(projectId: unknown) {
  const { userId } = await verifySession();          // authenticate — throws or redirects
  const id = z.string().min(1).parse(projectId);     // validate — arguments are attacker-controlled
  const project = await db.project.findFirst({ where: { id, ownerId: userId } }); // authorize — ownership
  if (!project) throw new Error('Not found');

  await db.project.update({ where: { id }, data: { archivedAt: new Date() } });
  revalidatePath('/projects');
}
```

- Rendering the form only for admins is not authorization — the request can
  be sent without the page.
- Identity comes from the session, never from a form field, hidden input or
  bound argument (`action.bind(null, ownerId)`); those all come back from
  the client.
- Variables an inline action closes over are encrypted before reaching the
  client, but do not put secrets in closures and rely on that alone.
  Self-hosted across several instances, set a shared
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.
- Rate-limit expensive or abusable actions: sign-in, sign-up, email
  sending, anything that costs money.

## Validate input with a schema

`FormData`, action arguments, `params`, `searchParams`, headers, cookies and
JSON bodies are all untrusted. Parse them with zod (or the project's schema
library) at the boundary — in the action, handler or page — and pass typed
data inward. Folders in brackets are user input too.

`z.object()` strips undeclared keys, which makes the schema the
mass-assignment defence. Never spread raw form data into a write:

```ts
// Unsafe — role, ownerId, anything the client adds reaches the database
await db.user.update({ where: { id }, data: Object.fromEntries(formData) });

// Safe — only declared fields survive, and the row is the caller's own
const data = ProfileSchema.parse(Object.fromEntries(formData));
await db.user.update({ where: { id: session.userId }, data });
```

A schema checks shape only. A well-formed id can still point at someone
else's row — ownership is a database check, as above.

## Authentication and authorization

Use an established library (Auth.js, Better Auth, Clerk, …) or the
session patterns in the Next.js authentication guide — check which this
project uses and verify its current API with its own docs, since auth
libraries move independently of Next.js. Session cookies are `httpOnly`,
`secure` and `sameSite`, and are set or deleted in Server Actions, Route
Handlers or proxy responses — never during render.

Authorization belongs in the DAL, next to the data: a `verifySession()`
memoized with `cache()` that every data function calls, plus ownership
conditions in the queries themselves. Not in these places:

- **Proxy** — optimistic checks only (a session cookie exists → don't bounce
  to `/login`). Matchers change, Server Actions are POSTs to the page route
  so an excluded path skips them, and CVE-2025-29927 let a crafted header
  skip middleware entirely on unpatched self-hosted versions. Keep `next`
  patched and the real checks in the DAL.
- **Layouts** — they do not re-render on navigation, so their check does not
  run per page. A layout that hides `children` or a parallel slot does not
  stop that segment rendering or appearing in the RSC payload.
- **Client Components** — a hidden button is UI, not a permission.

`forbidden()` and `unauthorized()` with matching file conventions exist
behind the experimental `authInterrupts` flag — verify before using.

## Do not leak data to the client

Everything below reaches the browser and can be read in the page source or
network tab: props passed to Client Components, Server Action return
values, Route Handler responses.

- DAL functions return DTOs built from an explicit `select` — never a whole
  row. A user object with `passwordHash` passed to a component that "only
  renders the name" is a leak.
- `import 'server-only'` at the top of the DAL, the database client, the env
  module and anything holding secrets turns an accidental client import into
  a build error. `client-only` does the reverse for browser-only modules.
- React's taint APIs (`experimental_taintObjectReference`,
  `experimental_taintUniqueValue`, behind `experimental.taint`) are a
  backstop, not a substitute for DTOs.
- Production redacts Server Component errors to a message plus `digest`.
  Keep it that way: actions return expected errors as plain values with no
  stack traces, SQL or internal ids.

## Environment variables and secrets

- Only `NEXT_PUBLIC_*` variables reach the browser — inlined into the
  bundle at build time. Anything with that prefix is public; never give it to
  a secret. The `env` key in `next.config` inlines values too.
- An unprefixed variable read in client code is replaced with an empty
  string — a silent bug rather than a leak, but `server-only` makes it loud.
- Local secrets go in `.env*.local` files, which stay out of version
  control; production secrets come from the platform's secret store.
- Don't log secrets, tokens, cookies or full request payloads.

## CSRF

Server Actions accept only POST, and Next.js compares the `Origin` header
with `Host` (or `X-Forwarded-Host`), rejecting mismatches; with `SameSite`
cookies that blocks the classic attack. Behind a proxy or CDN that changes
the host, list the public host in `serverActions.allowedOrigins` (under
`experimental` in current versions — verify) rather than weakening the
check.

Route Handlers get no such protection. A cookie-authenticated handler that
mutates must check `Origin` itself, require a JSON content type or a CSRF
token, and keep cookies `SameSite=Lax` or stricter. Never mutate in a `GET`
handler or during render — no logout-by-query-string.

## Injection and unsafe output

- **SQL** — ORM query builders parameterize. For raw SQL use the
  tagged-template forms that bind values (Prisma `$queryRaw`, Drizzle's
  `sql` tag); never `$queryRawUnsafe` or `sql.raw()` with user input.
  Identifiers such as a sort column cannot be bound — allow-list them.
- **XSS** — React escapes text. `dangerouslySetInnerHTML` only with
  sanitized HTML, including Markdown rendered to HTML. Allow only `https:`
  and relative URLs in user-supplied `href`/`src`.
- **Open redirects** — `redirect(searchParams.callbackUrl)` must accept only
  same-origin relative paths.
- **SSRF** — validate user-supplied URLs before fetching them server-side,
  and keep `images.remotePatterns` to exact hosts rather than wildcards.

## Headers and Content Security Policy

Set static security headers in `next.config` `headers()`:
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `frame-ancestors` (or `X-Frame-Options`),
`Permissions-Policy`. Turn off `X-Powered-By` with `poweredByHeader: false`.

A nonce-based CSP is generated per request in proxy and set as a header;
Next.js applies the nonce to its own scripts. That requires dynamic
rendering — it rules out static pages and prerendered shells. For static
routes, consider the experimental hash-based Subresource Integrity support,
or a CSP without nonces. Verify the current guidance with the MCP before
choosing.

## Reviewing code

Check for: a Server Action without an authentication and ownership check;
form data spread into an ORM write; a DAL or db module without
`server-only`; whole records passed to Client Components or returned from
actions; secrets behind `NEXT_PUBLIC_`; authorization living only in proxy,
a layout or the UI; `redirect()` to a user-supplied URL;
`$queryRawUnsafe`/`sql.raw()` with input; unsanitized
`dangerouslySetInnerHTML`; a `GET` handler or render path that mutates;
wildcard `images.remotePatterns`; an outdated `next` with published
advisories.
