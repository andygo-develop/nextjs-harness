# @andygo.dev/nextjs-harness

A local AI development harness for Next.js projects.

It gives AI coding agents **version-aware, local, authoritative Next.js
knowledge**, while keeping *how to write Next.js code* separate from *what the
framework actually does*:

- **Guidance** — development conventions, architecture and testing practice
- **Roles** — `nextjs-expert`, `nextjs-code-reviewer`, `nextjs-test-writer`
  and `nextjs-planner`, which verify APIs against the docs instead of
  recalling them
- **Manuals + MCP** — the official Next.js documentation for *your* version
- **Project specs** *(optional)* — your own docs and specs, in a separate corpus
- **Config** — how this specific project should be developed

The problem it solves: an agent confidently inventing a Next.js API, or
answering a Next.js 16 question from Next.js 14 memory — synchronous `cookies()`,
`middleware.ts` instead of `proxy.ts`, `fetch` cached by default.

It works with **Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI and
OpenCode** — one source of guidance, rendered into whatever each tool reads, so
a team on mixed tooling cannot end up with two versions of "how we write Next.js
here".

```
Developer
    │  npx @andygo.dev/nextjs-harness setup
    ▼
Next.js Harness ── detects version ── installs guidance ── syncs manuals ── indexes ── serves MCP
                                                                                        │
                                                                                        ▼
                                                      Claude Code · Cursor · Codex · Gemini CLI · OpenCode
```

## Requirements

- Node.js **>= 22.13** (uses the built-in `node:sqlite`)
- A Next.js project with a `package.json` depending on `next`

No native modules, no compilation, no database server.

## Quick start

```bash
cd my-nextjs-project
npx @andygo.dev/nextjs-harness setup
```

Or install the CLI once and run the binary:

```bash
npm install -g @andygo.dev/nextjs-harness
cd my-nextjs-project
nextjs-harness setup
```

That detects your Next.js version, detects which coding agents the project
already uses, installs the guidance and roles for each of them, downloads and
indexes the matching manuals, and offers to register the MCP server with each
agent.

To choose the agents yourself:

```bash
nextjs-harness setup --target claude-code --target cursor
```

Then:

```bash
nextjs-harness manuals search "revalidate data after a server action"
```

```
1. Server Actions and Mutations › Choosing a cache update
   Section: App Router › Guides
   Version: v16.3.8 (project: 16.1)
   URL: https://nextjs.org/docs/app/guides/server-actions#choosing-a-cache-update
   Id:  v16.3.8:en:01-app/02-guides/server-actions.mdx#choosing-a-cache-update

   After mutating data, on-demand revalidation updates the server cache, the client router, or both…
```

## Checking your setup

```bash
nextjs-harness doctor
```

```
✓ Next.js project detected
✓ Next.js version: 16.1
✓ Manuals synchronized
✓ Documentation index available
✓ Next.js Skill installed
✓ Cursor guidance installed
✓ MCP server available
✓ search_nextjs_manual available
✓ get_nextjs_manual available
✓ search_nextjs_api available

Available commands:
  nextjs-harness setup                       Run the full idempotent setup flow
  nextjs-harness doctor                      Check setup health and list available commands
  nextjs-harness init                        Detect the project and create .nextjs-harness/
  nextjs-harness manuals sync                Download the official Next.js manuals
  nextjs-harness manuals index               Build the manual search index
  nextjs-harness manuals update              Sync manuals and update the index
  nextjs-harness manuals search <query>      Search the Next.js manuals
  nextjs-harness manuals status              Show synchronized and indexed manual status
  nextjs-harness manuals versions            List documentation lines and local status
  nextjs-harness specs index                 Index this project's own specs
  nextjs-harness specs search <query>        Search this project's own specs
  nextjs-harness specs status                Show project spec search status
  nextjs-harness targets list                List coding agents and their setup state
  nextjs-harness targets add <agent>         Set this project up for another coding agent
  nextjs-harness targets remove <agent>      Stop maintaining files for a coding agent
  nextjs-harness targets install             Reinstall files for every configured agent
  nextjs-harness skill install                Install the Next.js guidance
  nextjs-harness skill update                 Update the Next.js guidance
  nextjs-harness agent install                Install the Next.js roles
  nextjs-harness agent update                 Update the Next.js roles
  nextjs-harness mcp start                    Run the MCP server on stdio
  nextjs-harness mcp status                   Show MCP registration and readiness
```

The MCP checks are not assertions — `doctor` stands the server up over an
in-memory transport, lists its tools and calls them, so a tool that is
registered but broken (stale index, version drift) is reported as broken.
Failures print the command that fixes them, and the exit code is non-zero,
which makes it usable as a CI gate. `doctor` also prints the complete command
catalog so it doubles as command discovery. `--json` emits the full report,
including the command catalog.

## Commands

| Command | What it does |
|---|---|
| `setup` | Everything below, in one idempotent command |
| `doctor` | Check setup health and list available commands (`--json`) |
| `init` | Detect the project and create `.nextjs-harness/` (no downloads) |
| `manuals sync` | Download the official manuals for your version |
| `manuals index` | Build the SQLite/FTS5 search index |
| `manuals update` | Sync, then incrementally reindex — the everyday command |
| `manuals search <query>` | Search the manuals (`--limit`, `--full`, `--version`) |
| `manuals status` | What is synced and indexed (`--json`) |
| `manuals versions` | Documentation lines and their local status |
| `specs index` | Index this project's own specs (opt-in; enables spec search) |
| `specs search <query>` | Search this project's own specs (`--limit`, `--full`, `--tag`) |
| `specs status` | Whether project spec search is enabled and current (`--json`) |
| `targets list` | Coding agents, and whether each is set up (`--json`) |
| `targets add <agent>` | Set the project up for another agent and install its files |
| `targets remove <agent>` | Stop maintaining an agent's files (deletes nothing) |
| `targets install` | Reinstall guidance, roles and MCP for every configured agent |
| `skill install` / `skill update` | Install or refresh the guidance, for every agent |
| `agent install` / `agent update` | Install or refresh the roles, for every agent |
| `mcp start` | Run the MCP server on stdio (your coding agent launches this) |
| `mcp status` | Registration per agent and documentation readiness (`--json`) |

Add `--verbose` to any command for diagnostics and stack traces. `setup`,
`targets install`, `skill install` and `agent install` accept `--target <agent>`
(repeatable) to work on one agent at a time.

Every command is safe to run repeatedly. `manuals update` detects that nothing
changed and does no work; nothing will clobber your local edits.

## What gets created

Always:

```
.nextjs-harness/
├── config.json                       project configuration
├── manuals/nextjs-v16.3.8/           synced MDX + .meta.json
├── index/docs.sqlite                 FTS5 search index (framework manual)
├── index/specs.sqlite                FTS5 search index (project specs, optional)
├── targets/<agent>.json              what the harness installed, per agent
└── cache/                            download cache
```

Then, per coding agent — only for the ones your project is set up for:

```
Claude Code       .claude/skills/nextjs/        SKILL.md + references/
                  .claude/agents/*.md           four subagents
                  .mcp.json

Cursor            .cursor/rules/nextjs.mdc      rule, auto-attached to **/*.{ts,tsx,js,jsx,mdx}
                  .cursor/commands/*.md         four role playbooks
                  .cursor/mcp.json

OpenAI Codex CLI  AGENTS.md                     a marked-off block, merged in
                  .codex/config.toml

Gemini CLI        GEMINI.md                     a marked-off block, merged in
                  .gemini/commands/nextjs/*.toml   /nextjs:expert, …
                  .gemini/settings.json

OpenCode          AGENTS.md                     a marked-off block, merged in
                  .opencode/agent/*.md          four subagents
                  opencode.json
```

Agents that do not keep guidance in a self-contained directory share one copy of
the reference documents at `.nextjs-harness/instructions/references/`, which
their guidance file links to.

MCP registration files are only written if you approve the prompt.

The npm package contains the tooling. Documentation is downloaded locally by
`manuals sync`, never bundled.

Package name:
[`@andygo.dev/nextjs-harness`](https://www.npmjs.com/package/@andygo.dev/nextjs-harness).
The installed CLI binary is still `nextjs-harness`.

## Coding agents

Which agents a project is set up for is recorded in `config.json` as `targets`,
and `init` proposes what it can detect (`.cursor/`, `.codex/`, `GEMINI.md`,
`opencode.json`, …). Detection only ever informs a *new* config — once the list
is recorded it is your decision, and adding `.cursor/` to a repository will not
silently start writing Cursor files.

```bash
nextjs-harness targets list
```

```
Agent        Set up   Detected   MCP
claude-code  yes      yes        yes
cursor       yes      yes        yes
codex        —        yes        —
gemini       —        —          —
opencode     —        —          —
```

```bash
nextjs-harness targets add codex
nextjs-harness targets remove cursor
```

`targets remove` stops maintaining an agent's files; it never deletes them. They
are in your repository, possibly committed and possibly edited, and quietly
deleting them because a config list changed is not a trade this tool makes. It
prints exactly what was left behind.

### One source of guidance

The conventions are written once, in this package's Skill templates, and
rendered per agent. The four roles are written once as subagent definitions and
re-expressed as whatever the tool actually supports:

| Agent | Roles become | Permissions |
|---|---|---|
| Claude Code | subagents in `.claude/agents/` | native `tools:` list |
| OpenCode | subagents in `.opencode/agent/` | translated to `tools: {write: false, …}` |
| Gemini CLI | commands — `/nextjs:expert`, … | not expressible |
| Cursor | commands in `.cursor/commands/` | not expressible |
| OpenAI Codex CLI | playbook documents it is pointed at | not expressible |

Two details there are load-bearing. Claude Code namespaces MCP tools as
`mcp__<server>__<tool>` and other clients do not, so the prefix is stripped for
them — a role telling Gemini CLI to call `mcp__nextjs-docs__search_nextjs_manual`
would simply never look anything up. And the reviewer's read-only restriction is
translated rather than dropped where the syntax differs; where a tool cannot
express it at all, that is stated rather than assumed.

`AGENTS.md` is shared by Codex and OpenCode, so a project set up for both gets
**one** block describing both, rather than each overwriting the other's on every
run.

## MCP tools

Once registered, your coding agent gains these tools:

| Tool | Purpose |
|---|---|
| `search_nextjs_manual` | Ranked search; returns compact excerpts + `documentId` |
| `get_nextjs_manual` | Full document text for a `documentId` |
| `search_nextjs_api` | Look up a function, component, hook, file convention or config option |
| `search_project_specs` | Search this project's own specs (optional, see below) |
| `get_project_spec` | Full text of one of this project's spec documents |

Results are deliberately small — title, section, version, URL, excerpt,
`documentId` — so a search never floods the context window. The agent fetches
full documents only when it needs them.

## Project specs (optional)

Beyond the framework manual, the harness can index **your project's own** specs,
design notes and ADRs — the knowledge that explains how *this* application is
meant to behave.

It is opt-in. Nothing scans your repository until you run:

```bash
nextjs-harness specs index
nextjs-harness specs search "invoice numbering"
```

```
1. Billing Rules › Invoice Numbering
   Section: docs
   File: docs/billing.md#invoice-numbering
   Id:   spec:docs/billing.md#invoice-numbering

   Invoice numbers use the prefix ACME- followed by a zero-padded sequence…
```

Which files count is configurable:

```json
"specs": {
  "enabled": true,
  "include": ["docs/**/*.md", "specs/**/*.md", "*.md"],
  "exclude": ["vendor/**", "node_modules/**", ".nextjs-harness/**", ".claude/**",
              ".cursor/**", ".codex/**", ".gemini/**", ".opencode/**",
              "AGENTS.md", "CLAUDE.md", "GEMINI.md"]
}
```

An include entry can also be an object that **tags** every file it matches:

```json
"specs": {
  "enabled": true,
  "include": [
    { "path": "docs/**/*.md", "tags": ["docs"] },
    { "path": "docs/adr/**/*.md", "tags": ["adr"] },
    { "path": "specs/**/*.md", "tags": ["specs"] },
    "*.md"
  ]
}
```

A file matched by several entries carries all of their tags (`docs/adr/0001.md`
above is tagged `adr` and `docs`); a bare glob adds none. Tags are matched
case-insensitively. Narrow a search to specs carrying **at least one** of the
given tags with `search_project_specs`' optional `tags` parameter, or on the
command line:

```bash
nextjs-harness specs search "storefront" --tag adr --tag specs
```

Changing tags only needs `nextjs-harness specs index` — it rewrites the tags
without re-embedding unchanged content.

Discovery prunes excluded directories rather than walking them, skips symlinks
so it cannot escape the project, and indexes incrementally by content hash like
the manual does.

The excludes cover every file the harness installs for a coding agent. Those
hold *framework* guidance, and indexing them here would let Next.js conventions
come back out of `search_project_specs` dressed as this project's own
requirements.

**The two corpora never mix.** Project specs live in their own SQLite database
(`index/specs.sqlite`) with their own tools, so a project design note cannot be
returned by `search_nextjs_manual` — that separation is structural, not a
filter that could be got wrong. The tool descriptions and the server
instructions both state which corpus is which, so an agent does not present
your internal ADR as Next.js framework behaviour.

## The Next.js roles

`setup` installs four roles for every coding agent the project is set up for:

| Role | Does | Tools |
|---|---|---|
| `nextjs-expert` | Implements and refactors Next.js code | full (reads, edits, runs) |
| `nextjs-code-reviewer` | Reviews Next.js code for defects | **read-only** + MCP lookups |
| `nextjs-test-writer` | Writes and repairs tests | read/write + Bash + MCP lookups |
| `nextjs-planner` | Plans features, refactors and migrations before implementation | **read-only** + MCP lookups |

In Claude Code and OpenCode they are subagents:

```
> use the nextjs-expert agent to add rate limiting to the auth module
> use the nextjs-planner agent to plan the billing refactor
> use the nextjs-code-reviewer agent on my changes
> use the nextjs-test-writer agent to cover UsersService
```

In Gemini CLI they are commands (`/nextjs:expert`, `/nextjs:code-reviewer`,
`/nextjs:test-writer`, `/nextjs:planner`); in Cursor, commands in
`.cursor/commands/`; in Codex, playbook documents its `AGENTS.md` block points
at.

### Forcing a role

Only `nextjs-expert`'s description says `Use PROACTIVELY`, so it is the one
role a coding agent may reach for on its own for Next.js implementation work.
The other three — `nextjs-planner`, `nextjs-code-reviewer`, `nextjs-test-writer`
— only run when you ask for them by name; left unnamed, the agent is free to
handle planning, review or tests inline itself instead of delegating.

To force a specific role rather than leaving that choice to the agent, invoke
it explicitly:

- **Claude Code / OpenCode** — name the subagent in your prompt, as in the
  examples above (`use the nextjs-code-reviewer agent to review this`). Naming
  it dispatches the whole task to that subagent instead of the top-level agent
  answering inline.
- **Gemini CLI** — run its command directly: `/nextjs:expert`,
  `/nextjs:planner`, `/nextjs:code-reviewer`, `/nextjs:test-writer`.
- **Cursor** — run the matching command from `.cursor/commands/`.
- **Codex** — there is no separate role to invoke. Its playbook is folded into
  the ambient `AGENTS.md` block and applies on every turn, so there is nothing
  to force on.

Those are all per-prompt. For a standing rule, edit `CLAUDE.md` — the harness
never writes to it (Claude Code's guidance lives in `.claude/skills/nextjs/`
and `.claude/agents/*.md` instead, see the layout above), so it is a clean
place to add project-wide delegation policy without colliding with anything
`skill update`/`agent update` maintain. For example:

```markdown
## Subagent policy

- Always use the nextjs-code-reviewer subagent to review Next.js changes
  before reporting a task done.
- Always use the nextjs-test-writer subagent when adding or fixing tests
  for Next.js code.
```

That turns delegation into the default for that kind of work project-wide,
instead of something asked for each time — effectively a project-scoped
`Use PROACTIVELY` for a role that doesn't carry it by default. The same idea
applies to the other targets' own ambient files (`AGENTS.md` for Codex/
OpenCode, `GEMINI.md` for Gemini CLI, `.cursor/rules/` for Cursor) — but
those already carry a harness-managed block, so add project-specific policy
like this outside of it, not inside the marked-off section `agent
update`/`skill update` own.

All four share one defining rule: **verify framework APIs against the
documentation before asserting them**. For the expert that means searching
before writing; for the planner it means grounding implementation steps in this
project's actual Next.js version; for the reviewer it means confirming an API
really is wrong before flagging it — a review that confidently flags correct
code is worse than no review; for the test writer it means checking that a
testing utility actually exists in this version before relying on it.

The **reviewer** is restricted to `Read, Grep, Glob, Bash` plus the three MCP
tools, so it cannot rewrite the code it is reviewing — translated to
`write: false, edit: false` for OpenCode, and stated in the prose for tools that
cannot enforce it. It reports findings as
Critical / Warning / Suggestion with `file:line` and a concrete fix, covering
Next.js-specific defects: a Server Action that never checks who is calling it
(every action is a public endpoint), secrets or server-only modules reaching a
Client Component, `NEXT_PUBLIC_` on a value that must stay private, `'use client'`
placed far higher in the tree than it needs to be, authorization enforced only
in `proxy.ts`/`middleware.ts`, sequential `await` waterfalls, a mutation that
never revalidates what it changed, synchronous access to request APIs that are
asynchronous since Next.js 15, and missing tests for new behaviour.

The **test writer** carries two hard rules that tool permissions cannot express:
it never edits production code to make a test pass (a failing test it wrote is a
bug found, and it reports it instead), and it never claims a suite passes
without actually running it. It knows the Next.js testing surface — Vitest or
Jest with React Testing Library for Client Components, Server Actions and Route
Handlers exercised as plain functions with `next/headers`/`next/navigation`
mocked, and Playwright end-to-end tests against a production build for async
Server Components — and is told to cover failure paths, not just happy paths.

In Claude Code, tool names are namespaced by your MCP server name
(`mcp__nextjs-docs__search_nextjs_manual`), so all four roles are rendered with
the `mcp.serverName` from your config at install time — rename the server and
`agent update` rewires them.

Unlike the ambient guidance, a subagent runs in a separate context with its own
tool budget. Use the guidance for everyday Next.js work; reach for a role on
larger, self-contained tasks.

### Manual registration

`setup` asks before touching any MCP configuration file. To do it yourself, in
`.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) or `.gemini/settings.json`
(Gemini CLI):

```json
{
  "mcpServers": {
    "nextjs-docs": {
      "command": "npx",
      "args": ["-y", "@andygo.dev/nextjs-harness", "mcp", "start"]
    }
  }
}
```

In `opencode.json` (OpenCode):

```json
{
  "mcp": {
    "nextjs-docs": {
      "type": "local",
      "command": ["npx", "-y", "@andygo.dev/nextjs-harness", "mcp", "start"],
      "enabled": true
    }
  }
}
```

In `.codex/config.toml` (Codex CLI — it also reads `~/.codex/config.toml`):

```toml
[mcp_servers.nextjs-docs]
command = "npx"
args = ["-y", "@andygo.dev/nextjs-harness", "mcp", "start"]
```

Existing servers in these files are never modified, and an entry for our own
server that you have customised is left alone.

## Version safety

This is the point of the tool, so it is strict.

```
Claude → MCP → project config → Next.js version → version-specific index → search
```

Next.js keeps its documentation in the framework's own repository
(`vercel/next.js`, under `docs/`), so the documentation for a release is
whatever `docs/` said at that release's git tag. The harness pins every known
major to the tag of its newest stable release on purpose: a tag never moves, so
the corpus a project syncs today is the same corpus it syncs next month, not
something that can silently drift out from under an already-built index. So the
harness maps:

- **16** → `v16.3.8`
- **15** → `v15.5.27`
- **14** → `v14.2.35`
- **13** → `v13.5.11` (13.4 is where the App Router documentation layout this
  tool reads first appeared)
- anything older → no documentation at all;
- a future major newer than anything the harness knows about yet → `canary` as
  a stopgap, since that is the only documentation upstream has for it until
  this map gains a pinned tag.

And it **never crosses a major-version boundary**: a 16.x project is never
served 15.x documentation, or vice versa. Search results link to the matching
version of nextjs.org — `/docs/…` for the newest major, `/docs/15/…`,
`/docs/14/…` for earlier ones.

If the right documentation is not available, you get an error, not a guess:

```
✖ Next.js 15.3 documentation has not been synchronized (corpus: nextjs-v15.5.27, language: en).

Run:

  nextjs-harness manuals sync
  nextjs-harness manuals index

Indexed documentation for other versions is present but will not be used:
  nextjs-v16.3.8 (en, 2266 documents)
```

Version detection prefers `package-lock.json` (exact, `16.1.4`) and falls back
to the `package.json` range (`^16.1.0`).

## How it works

**Sync** resolves the pinned tag for your major line to a commit and lists the
`docs/` tree at that commit — two GitHub API requests. The tree's own hash only
changes when a documentation file does, so if it matches what you have, nothing
is downloaded (that also keeps `canary` cheap, where most commits never touch
the docs). Otherwise it fetches the few hundred `docs/**/*.mdx` files from
`raw.githubusercontent.com`, pinned to that commit, rather than the whole
monorepo. Set `GITHUB_TOKEN` (or `GH_TOKEN`) if you hit the API rate limit.

**MDX** is reduced to the Markdown worth indexing: editor comments are dropped,
the JavaScript twin of each TypeScript code sample is skipped, and router-specific
blocks are resolved — a Pages Router page keeps its `<PagesOnly>` content and
drops `<AppOnly>`, and the many Pages Router pages that share an App Router
page's content (`source:` front matter) are indexed with that shared content.

**Indexing** splits each page into one document per `##` section — a section is
the unit a developer actually wants back, and whole pages rank badly and blow up
context. Each chunk is content-hashed, so re-indexing only touches what changed.

**Search** is BM25 via SQLite FTS5 by default, with title and heading weighted
above body text. Queries are tokenised and re-quoted before they reach FTS5, so
`"use client"`, `revalidateTag()` and `next/navigation` work rather than
throwing syntax errors. The search widens in stages: all terms → any term →
prefix.

**Hybrid search** *(optional)* blends that BM25 ranking with semantic
similarity from local embeddings, combined by reciprocal rank fusion — a query
phrased nothing like the manual's own wording (`"how do I make the page show
the new comment right after the form is submitted"`) can still surface the
right section. See
[Hybrid search](#hybrid-search-optional) below.

**Storage** is behind a repository interface so another backend can be added
later.

## Hybrid search (optional)

By default, search is BM25 only — lexical, offline, no extra dependency. Set
`index.searchStrategy` to `"hybrid"` in `.nextjs-harness/config.json` to also
rank by semantic similarity from a local embedding model, blended with BM25 by
[reciprocal rank fusion](https://en.wikipedia.org/wiki/Learning_to_rank#Ranking_SVM):

```json
"index": {
  "searchStrategy": "hybrid",
  "embeddingModel": "Xenova/all-MiniLM-L6-v2"
}
```

Then reindex — hybrid search needs embeddings to search *against*, not just
the FTS5 index:

```bash
nextjs-harness manuals update
nextjs-harness specs index
```

This works on an index you already have: nothing needs to change on disk for
the embeddings to be filled in, and neither command re-downloads or re-parses
anything it does not have to. It is also resumable — if the run is interrupted,
everything embedded so far is kept and the next run picks up exactly what is
still missing.

`manuals status` reports readiness (`2266/2266 documents embedded`), and
`manuals search` / `search_nextjs_manual` refuse to run hybrid search with a
message telling you to reindex, rather than silently falling back to bm25,
unless *every* document in the corpus has an embedding for the configured
model. Reading a document by id (`get_nextjs_manual`) and `doctor` never
require embeddings, so neither is affected while a corpus is still filling in.

Why bother: BM25 only ever matches vocabulary that is actually in the query.
A query phrased in the developer's own words — `"how do I make the page show
the new comment right after the form is submitted"` — has almost no token
overlap with the manual's own vocabulary (*Server Actions*, *revalidatePath*),
which is exactly the gap embeddings close: they capture that the two mean the
same thing.

**What's actually running:** a small sentence-embedding model
(`Xenova/all-MiniLM-L6-v2` by default) via
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) —
transformers.js, a local WASM/ONNX runtime. No API key, no server, no
outbound calls per query. The model downloads once on first use
(a few tens of MB), reporting progress as it goes, and is cached after that.

**Trade-offs worth knowing before you opt in:**

- It is the one path in this package that is not "no native modules": in
  Node, transformers.js runs its ONNX graph through `onnxruntime-node`, a
  small **prebuilt** (not compiled) native addon. The default `bm25` strategy
  is entirely unaffected — this only loads if `searchStrategy` is `hybrid`.
- `@huggingface/transformers` is listed as an `optionalDependencies` entry
  specifically so a `bm25`-only install never has to carry it. It pulls in
  `onnxruntime-node` and `sharp` (image handling the text-embedding path here
  never uses), both of which currently have open, unpatched high-severity
  advisories in their dependency chains at the time of writing — check
  `npm audit` before deciding whether that is acceptable for your project.
- Indexing a full manual corpus (~2,300 chunks) takes noticeably longer
  than bm25-only, since every added or changed chunk needs an embedding. A
  chunk that is unchanged *and* already has a vector for the configured model
  is never re-embedded.
- Similarity is a brute-force cosine scan over stored vectors at query time —
  fine at the corpus sizes this tool deals with (low thousands of documents),
  deliberately not a dedicated ANN index for a problem this size does not have.

## Security

Downloaded documentation is untrusted input:

- only regular Markdown/MDX files listed in the `docs/` tree are fetched
- absolute paths, `..` segments and symlinks are rejected
- every destination is verified to resolve inside the manuals directory
- content is only ever stored and displayed — never executed, never
  interpolated into a shell command, never able to influence control flow

## Programmatic use

```ts
import { detectNextJsVersion, openCorpus, searchManuals } from '@andygo.dev/nextjs-harness';
```

The version model, config, sync, index, search, MCP server and the target
installers are all exported. To set a project up for an agent from your own
tooling:

```ts
import { installTargets, registerTargetServer, TARGETS } from '@andygo.dev/nextjs-harness';

await installTargets(['claude-code', 'cursor'], { root, serverName: 'nextjs-docs' });
await registerTargetServer(root, TARGETS.cursor, 'nextjs-docs');
```

## Development

```bash
npm install
npm run build
npm test          # fully offline (hybrid search is tested against a fake embedding provider)
npm run typecheck
```

## License

MIT
