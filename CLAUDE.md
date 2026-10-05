# CLAUDE.md

Guidance for Claude Code and other AI agents working in this repository.

## Project Overview

`nextjs-harness` is a Node.js/TypeScript CLI package that installs a local AI
development harness for Next.js projects. It provides version-aware Next.js
manual sync, SQLite/FTS search, per-coding-agent guidance and roles, and an MCP
server.

Supported coding agents ("targets"): Claude Code, Cursor, OpenAI Codex CLI,
Gemini CLI and OpenCode.

This repository is the harness implementation itself, not a Next.js
application.

## Runtime and Tooling

- Node.js: `>=22.13.0` is required because the project uses built-in
  `node:sqlite`.
- Package manager: npm, with `package-lock.json` committed.
- Module system: ESM (`"type": "module"`) with TypeScript `module:
  "node16"`.
- Tests: Vitest, fully offline by design.
- Linting: ESLint flat config with `typescript-eslint`.

## Common Commands

Run these from the repository root:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Useful development commands:

```bash
npm run test:watch
npm run lint:fix
node ./bin/nextjs-harness.js --help
node ./bin/nextjs-harness.js doctor --help
```

`nextjs-harness doctor` is both the setup health check and the command
discovery entrypoint. Keep its command catalog current whenever adding,
removing, or renaming CLI commands.

## Repository Layout

- `bin/nextjs-harness.js` - executable CLI entrypoint.
- `src/cli/` - command registration and command implementations.
- `src/cli/nextjs/` - Next.js project/version detection.
- `src/generators/config-generator/` - harness configuration schema and loading.
- `src/rags/manuals/` - Next.js manual download, parsing, indexing, and search
  (bm25 by default; hybrid when `index.searchStrategy` is `"hybrid"`).
- `src/rags/specs/` - optional project-spec discovery, parsing, indexing, and
  search — same bm25/hybrid split as manuals.
- `src/rags/embeddings/` - the hybrid search machinery shared by both corpora.
  All of it is corpus-agnostic on purpose: a fix here lands once instead of
  twice.
  - `provider.ts` - the `EmbeddingProvider` contract, cosine similarity, and
    vector (de)serialization. Pure and dependency-free; both repositories
    import it on every run, bm25 included.
  - `rrf.ts` - reciprocal rank fusion.
  - `hybrid.ts` - the fusion pipeline itself (`fuseHybrid`, `hybridPoolSize`)
    and the shared "not fully embedded" error. Manuals and specs supply only
    their own `listVectors`/`get`.
  - `indexing.ts` - the batching writer both indexers embed through.
  - `transformers-provider.ts` - the real `@huggingface/transformers`-backed
    provider. This is the module that must stay off the bm25 path in
    *substance*: the optional dependency is dynamically imported inside
    `loadPipeline`, so nothing is downloaded or loaded unless something
    actually calls `embed()`.
- `src/mcp/` - the MCP protocol server itself: server, context, and tools. Not
  where per-agent files get written — see `src/generators/`.
- `src/generators/` - everything that writes files into a developer's project:
  - `targets/` - the registry of coding agents, and the writers for guidance,
    roles and MCP registration in each agent's own dialect.
  - `skill/` and `agent/` - installation logic for the Claude Code Skill and
    subagents, used by the `claude-code` target.
  - `template-installer.ts` - the shared, idempotent, edit-preserving template
    engine every generator is built on.
  - `mcp-entry.ts` - the one description of the `npx … mcp start` launch
    command, shared by every target's MCP registration.
  - `ai-code-mcp.ts` - the named Claude Code entry point for MCP
    registration (thin wrapper over `targets/mcp.ts`).
- `src/generators/templates/` - bundled skill and agent template source files. These are
  the single source of guidance; every generator renders from them.
- `src/tests/` - Vitest test suite.
- `dist/` - generated build output. Do not edit by hand.

## Development Guidelines

- Prefer changing TypeScript sources in `src/`; regenerate `dist/` with
  `npm run build` when build artifacts need to be updated.
- Keep CLI commands idempotent. Existing commands are designed to be safe to run
  repeatedly.
- Keep tests offline. Network access in tests is a bug unless a test explicitly
  mocks the boundary.
- Preserve the separation between Next.js manual search and project-spec search.
  They are separate corpora with separate indexes and MCP tools.
- Use structured parsing/indexing code for documentation and specs rather than
  ad hoc string manipulation when existing helpers apply.
- Follow the existing error style and include actionable recovery commands for
  user-facing failures where practical.
- Do not clobber local skill or agent edits during install/update flows unless
  the command contract explicitly allows it.
- Adding a coding agent means adding a `TargetDefinition` in
  `src/generators/targets/registry.ts` and teaching the three writers about its
  dialect — never a second copy of the guidance. Content lives only in
  `src/generators/templates/`.
- Files in a project's own directories (`.cursor/`, `AGENTS.md`, `opencode.json`)
  belong to the developer. Merge into them, never rewrite them wholesale, and
  keep harness bookkeeping in `.nextjs-harness/targets/`.
- A restriction expressed for one agent (the reviewer cannot write) must be
  translated for the others, or reported as unsupported — never silently
  dropped because the syntax differs.
- Hybrid search is opt-in and must stay that way: the default `bm25` strategy
  may never load `@huggingface/transformers` or touch the network. It is an
  `optionalDependencies` entry, dynamically imported inside
  `transformers-provider.ts`'s `loadPipeline`, and only reached when something
  calls `embed()` — which only happens under `index.searchStrategy: "hybrid"`.
  Statically importing the pure modules in `src/rags/embeddings/` is fine and
  expected; importing the transformers package itself at module scope is not.
- Opting into hybrid on a corpus already indexed under bm25 must work in place.
  Content hashes decide what to *re-index*; they say nothing about whether a
  vector exists, so what to *embed* is decided by `idsWithVectors` as well.
  Never make embedding conditional on the hash alone — that is how the feature
  becomes unreachable for every existing install.
- Embedding readiness is counted, never sampled. A partially embedded corpus
  must be refused (`requireEmbeddings`), because ranking against a fraction of
  the index is a silent quality collapse. `hasVectors` is a diagnostic;
  `vectorCount` is the gate.
- Keep the embeddings gate out of `openCorpus`/`openSpecCorpus` themselves.
  Opening a corpus is also how document fetches and `doctor` reach it, and
  neither needs an embedding — only search calls `requireEmbeddings()`.
- Never call the real `createTransformersEmbeddingProvider(...).embed()` from
  a test — it needs a network-fetched model. Use
  `makeFakeEmbeddingProvider()` from `tests/helpers.ts` instead. Constructing
  the real provider (without calling `.embed()`) is fine and is how
  `requireEmbeddings()` readiness is tested offline.
- `docsLine` is a real upstream git ref in `vercel/next.js` (`v16.3.8`,
  `v15.5.27`, …), not a synthetic label — see the model comment at the top of
  `src/cli/nextjs/version.ts`. Next.js keeps its documentation inside the
  framework monorepo under `docs/`, so each known major is pinned to the tag
  of its newest stable release, on purpose, for a reproducible corpus.
  `canary` only appears as a stopgap for a major newer than anything in
  `DOCS_REF_BY_MAJOR`. When Next.js ships a new major (or a newer minor whose
  docs should be followed), that map needs a deliberate update — a new pinned
  tag, not just leaving it to the `canary` fallback. Verify the tag has the
  numbered `docs/**/*.mdx` layout before pinning it.
- Sync never downloads the monorepo. It lists the `docs/` subtree (one API
  request), skips everything when the tree SHA is unchanged, and fetches files
  from `raw.githubusercontent.com` pinned to the commit. Keep it that way —
  the repository tarball is orders of magnitude larger than the docs.
- Upstream docs are MDX. `cleanMdx` in `src/rags/manuals/normalizer.ts`
  resolves `<AppOnly>`/`<PagesOnly>` per router and drops comments and the
  JavaScript twin of "switcher" code samples; Pages Router pages with
  `source:` front matter are indexed with the shared App Router page's
  content (resolved in the indexer via `docsRoute`).

## Testing Expectations

For behavior changes, run the narrowest relevant Vitest tests first, then run
the full verification set when practical:

```bash
npm test
npm run typecheck
npm run lint
```

Add or update tests in `src/tests/` for changes that affect:

- CLI command behavior or output
- Next.js version detection
- manual/spec parsing, indexing, or search ranking
- MCP tool inputs/outputs
- skill, agent or target installation/update behavior
- per-target file layout, rendering, or MCP registration dialects
- config defaults, validation, or migration behavior

## Release Notes

The npm release script only runs from a clean, up-to-date `main` branch and then
publishes with public access. Do not run `npm run release` unless explicitly
asked.
