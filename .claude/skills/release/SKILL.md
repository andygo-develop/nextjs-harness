---
name: release
description: Create a release PR from a staging branch into main. Never touches the current branch or local working tree changes.
version: 0.3.0
model: sonnet
---

# release

Create a release Pull Request from a staging branch into `main`, with the version bump already included in the PR diff.

**The user's current branch and local working tree are never touched.**
All git introspection runs against remote refs. When the skill needs to push a version-bump commit, it does so inside a temporary detached worktree.

## Purpose

Automates the release PR workflow:

1. Identify the source (staging) branch and confirm it exists on the remote.
2. Detect all changes between the staging branch and `main` on the remote, auto-resolving trivial version-line conflicts.
3. Scan for breaking changes and surface them prominently.
4. Compute the target version from `main`'s version + the chosen bump level.
5. Stage the version bump on the source branch so it ships as part of the release PR diff.
6. Create or update a PR from staging → `main` with a structured release description.

Pushing the bump commit to the source branch is the only write the skill performs against the remote. The skill never merges the PR and never publishes to npm — both are manual steps the user takes after reviewing the PR. The skill does **not** prompt or instruct the user to perform them.

**Idempotency.** The target version is derived from `origin/main`'s `package.json` and the chosen bump level — it does **not** depend on whatever is currently on the source branch. So repeated `/release` calls with the same source branch and bump level produce the same target version and the same single bump commit on top of the source's content. If the user changes the bump level on a later call, the prior version-only tip commit on the source branch is replaced (force-push-with-lease), not appended to.

## Instructions

### Step 1: Determine Source Branch

- **Source branch** — a branch name passed as an argument (e.g. `/release staging`). If no argument is given, ask the user which branch to release.
- **Target branch** — always `main`.

Do **not** use the current local branch as the source. Do **not** check out or switch to any branch.

Confirm the source branch exists on the remote:

```bash
git ls-remote --heads origin <source-branch>
```

If it does not exist, stop and tell the user.

If source branch equals `main`, stop and tell the user to specify a different branch.

### Step 2: Validate Remote Branch State

Do **not** modify the working tree or index. All checks run against the remote refs fetched below.

```bash
git fetch origin main <source-branch>
```

Then run these checks:

1. **Up to date** — confirm `origin/<source-branch>` and the local tracking ref (if any) agree. If the remote is ahead of local, note it but do not pull.

2. **Conflicts** — verify the source branch can be merged into `main`:

   ```bash
   git merge-tree origin/main origin/<source-branch>
   ```

   Classify any conflicts found:

   - **Auto-resolvable** — every conflict is confined to `package.json` and/or `package-lock.json`, and within those files only the `"version"` field is in conflict. This happens routinely in release flows when both branches bumped the version independently. Step 6 will overwrite the version field to the target value anyway, so these conflicts dissolve once Step 6 runs. Log them as "auto-resolvable; will be reconciled by Step 6" and proceed.
   - **Real conflicts** — anything else (any conflict in a file other than `package.json`/`package-lock.json`, or any conflict in those files outside the `"version"` line). List the files and stop. Do not attempt to resolve real conflicts — the user owns those.

   To check the version-line constraint, inspect each `<<<<<<<` … `=======` … `>>>>>>>` block in the merge-tree output. A block is version-only if every line inside it (excluding the conflict markers) is either blank or contains only the `"version": "..."` field.

### Step 3: Collect All Changes

Collect diffs and commits between `origin/main` and `origin/<source-branch>` — never against local HEAD:

```bash
git log --oneline origin/main..origin/<source-branch>
git diff origin/main...origin/<source-branch>
```

Read every commit and every changed file. Build a complete picture of what this release contains before writing the PR description.

### Step 4: Detect Breaking Changes

Scan the diff carefully for:

- Removed or renamed public exports, functions, classes, or types
- Changed method signatures (parameter names/types/order, return types)
- Removed or renamed configuration keys or environment variables
- Changed default values that callers depend on
- Changed behavior that existing callers rely on (error types, event names, response shapes, HTTP status codes)
- Major version bumps in dependencies that themselves carry breaking changes
- Database schema changes that require migration (dropped columns, renamed tables, non-null constraints added)

Note every breaking change found, including the migration path for each.

### Step 5: Determine Target Version

The target version is computed from `main`'s version, **not** from the source branch's version. This is what makes repeated `/release` calls idempotent.

Read the current version from `main`:

```bash
git show origin/main:package.json | grep '"version"'
```

Pick the bump level from the changes:

- **Major** — any breaking changes detected.
- **Minor** — new features, new exports, or new capabilities; no breaking changes.
- **Patch** — bug fixes, documentation, refactoring, dependency updates only.

Compute the target version by applying the bump to `main`'s version:

- `major` — `X.Y.Z` → `(X+1).0.0`
- `minor` — `X.Y.Z` → `X.(Y+1).0`
- `patch` — `X.Y.Z` → `X.Y.(Z+1)`

Report to the user: `main`'s current version, the recommended bump level with justification, and the computed target version. Ask the user to confirm the bump level before continuing. The user may override (e.g. you suggested `patch`, they want `minor`) — recompute the target from `main`'s version using the override.

Do **not** apply the bump to the source branch's current version. If a previous `/release` run already pushed a bump commit, the source branch's version may differ from `main`'s — ignore it for target-version computation. Step 6 reconciles the source branch to the target.

### Step 6: Stage Version Bump on Source Branch

Goal: the tip of `origin/<source-branch>` is a single commit whose only change vs its parent is `"version": "<target>"` in `package.json` (and `package-lock.json` if present). The skill may freely overwrite the tip commit as long as that tip is a "version-only" commit (its diff against its parent touches only `package.json`/`package-lock.json` and only the `version` field).

If `source.version === target.version`, do nothing — the desired state already holds.

Otherwise:

```bash
SOURCE_TIP=$(git rev-parse origin/<source-branch>)
WORKTREE=$(mktemp -d -t release-XXXXXX)
git worktree add --detach "$WORKTREE" "$SOURCE_TIP"
```

If the tip commit is version-only, drop it so we replace rather than stack:

```bash
(cd "$WORKTREE" && git reset --hard HEAD~1)
```

(If the tip is not version-only, do not reset — we append a new bump commit instead. Either way, the next steps are the same.)

Set the exact target version (not a relative bump), commit, and push:

```bash
(cd "$WORKTREE" && npm version <target-version> --no-git-tag-version --allow-same-version)
(cd "$WORKTREE" \
  && git add package.json package-lock.json \
  && git commit -m "chore: bump version to <target-version>" \
  && git push --force-with-lease="<source-branch>:$SOURCE_TIP" \
       origin "HEAD:refs/heads/<source-branch>")
```

Then clean up:

```bash
git worktree remove "$WORKTREE"
git fetch origin <source-branch>
```

Notes:

- `--force-with-lease=<source-branch>:$SOURCE_TIP` only allows the push if the remote tip still matches what we observed. Concurrent pushes are rejected — stop and report. Never escalate to plain `--force`.
- `npm version <target> --no-git-tag-version --allow-same-version` writes the exact target version. **Never** invoke `npm run bump:<level>`, `npm version <level>`, or `npm run deploy*` here — those bump relatively (breaking idempotency) or publish (which is the user's call). If `npm` is unavailable, edit `package.json` (and `package-lock.json` if present) directly.

### Step 7: Create or Update the Release PR

Check whether a PR from the source branch into `main` already exists:

```bash
gh pr list --head <source-branch> --base main --json number,url,state
```

**If no PR exists** — create one with `gh pr create --base main --head <source-branch>`.
**If a PR exists** — update its title and body via `gh pr edit <number> --title "..." --body "..."`.

#### PR Title

Format: `release: <source-branch> → main` (e.g. `release: staging → main`).

If the branch name is a version (e.g. `release/1.2.0`), use: `release: v1.2.0`.

#### PR Description

Build the description in this order:

---

**If any breaking changes were found**, open with:

```markdown
## ⚠️ Breaking Changes

- <change 1> — <migration path>
- <change 2> — <migration path>
```

---

Then always include:

```markdown
## Summary

<2–4 sentences: what this release does and why it's going out now>

## What's Included

<Grouped list of changes by type. Each bullet is one logical change, not one commit. Synthesize; don't dump git log.>

### Features
- ...

### Fixes
- ...

### Internal / Refactoring
- ...

### Dependencies
- ...

### Documentation
- ...

(Omit sections that have no entries.)

## Release Notes

User-facing changelog entry for this release. Written for consumers of the package/service, not for internal reviewers. Rules:

- Use plain language — no internal jargon, no PR numbers, no commit hashes.
- Lead with what changed from the user's perspective, not how it was implemented.
- Group under **Added**, **Changed**, **Fixed**, **Removed** (omit empty groups).
- If a change has a breaking counterpart already listed in ⚠️ Breaking Changes, reference it here under **Changed** or **Removed** with a one-line migration hint.
- Keep each bullet to one sentence.

Example:

```markdown
## Release Notes

### Added
- `EmitterModule.forFeature({ logger })` — override the error logger per module without affecting the rest of the app.

### Changed
- `@OnEmitterEvent` now prefers the feature-level logger over the root logger when both are present.

### Fixed
- Listener errors in async handlers no longer propagate and crash the emitter loop.
```

## Risks

<Deployment concerns, rollback considerations, migration steps required, third-party service dependencies, feature flags to toggle. If none: "None — all changes are backward-compatible.">

## Version Bump

`<major | minor | patch>` → `<new-version>` (justification)

The version bump is included in this PR's diff (`package.json`, and `package-lock.json` if present).

## Test Plan

- [ ] All unit tests pass (`npm test`)
- [ ] Linting clean (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] <any manual verification steps specific to the changes>
- [ ] Verify no regressions in <key user-facing flows>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

### Step 8: Report Output

Report only what the skill did. Do **not** instruct the user to merge the PR or to publish — those are manual steps the user owns.

Provide:

- Source branch and commit range (`origin/main..origin/<source-branch>`).
- Number of commits and files changed.
- Breaking changes found (or "none").
- Version bump: `<old>` → `<new>` (`<level>`), and whether the bump commit was newly created by this run, replaced an existing version-only tip, or was already in place.
- Auto-resolved version-line conflicts from Step 2, if any.
- PR URL.

Stop after this report. Do not append "next steps", "to publish", "after merge", or similar prescriptive guidance — the user knows what to do.

## Success Criteria

The release PR should:

- Be created from the remote source branch — the user's local branch and working tree are untouched.
- Reflect the complete set of changes between `origin/main` and `origin/<source-branch>`.
- Surface any breaking changes prominently at the top.
- **Include the version-bump commit** (`package.json` updated to the target version) in the PR diff.
- Have a test plan that a reviewer can actually follow.
- Be mergeable (no real conflicts; any version-line conflicts from Step 2 are resolved by the target-version bump in Step 6).
