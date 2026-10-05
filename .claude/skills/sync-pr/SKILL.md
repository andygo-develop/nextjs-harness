---
name: sync-pr
description: Synchronize local changes with a Pull Request and ensure the branch is ready for review
version: 0.5.0
model: sonnet
context: fork
argument-hint: "[target-branch]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Edit
---

# sync-pr

Synchronize local changes with a Pull Request and ensure the branch is ready for review.

## Purpose

This skill automates the workflow of preparing code changes for review by:

1. Performing a local code review.
2. Ensuring changes are on a feature branch.
3. Syncing the branch with its target and resolving conflicts.
4. Committing all pending changes with a detailed commit message.
5. Squashing all branch commits into one.
6. Pushing the branch to remote.
7. Creating or updating a Pull Request.

## Instructions

### Step 1: Local Code Review

Before any git operations:

- Review all modified files.
- Look for:
    - Bugs and logic issues.
    - Code style inconsistencies.
    - Missing error handling.
    - Security concerns.
    - Performance problems.
    - Missing tests.
- Run the project linter if one exists (e.g. `npm run lint`) and apply safe fixes automatically.
- Summarize findings before continuing.

### Step 2: Determine Target Branch and Ensure on a Feature Branch

**Target branch** — use the branch name passed as an argument (e.g. `/sync-pr main`). If no argument is given, default to `staging`.

Check the current branch.

If currently on the target branch or another protected branch (`main`, `staging`, `dev`):
- Stash any uncommitted changes.
- Create a new feature branch from the current HEAD, following repository naming conventions.
- Apply the stash on the new branch.

If already on a feature branch:
- Continue using it.

### Step 3: Sync with Target and Resolve Conflicts

Fetch the latest changes from remote.

Check whether the branch is behind its target (the branch determined in Step 2, defaulting to `staging`).

If the branch is behind:
1. Rebase or merge according to repository conventions.
2. Resolve straightforward conflicts automatically.
3. Run relevant validation commands after resolving.
4. Push the updated branch.

If conflicts require a business decision:
- Stop, explain the conflicting changes in detail, and request user guidance before proceeding.

### Step 4: Commit Changes

Review all staged and unstaged changes.

Stage all relevant files (avoid accidentally including build artifacts, secrets, or unrelated changes).

Create a commit message following repository conventions. Include:
- A concise summary line.
- Key implementation details.
- Important fixes.
- Test updates.

Example:

```
feat(auth): improve token refresh handling

- Add automatic refresh retry logic
- Prevent duplicate refresh requests
- Improve error reporting
- Add unit tests for expiration scenarios
```

Do not create empty commits.

### Step 5: Squash All Branch Commits into One

Count how many commits the branch has ahead of its target:

```bash
git rev-list --count <target-branch>..HEAD
```

If there is only one commit, skip this step.

If there are multiple commits:
1. Soft-reset to the merge base to collapse all commits into staged changes:
   ```bash
   git reset --soft $(git merge-base HEAD <target-branch>)
   ```
2. Write a single, comprehensive commit message that consolidates the intent of all the squashed commits (do not just concatenate them — synthesize a clear summary with bullet points for key details).
3. Commit:
   ```bash
   git commit -m "..."
   ```
4. If the branch was already pushed to remote, force-push with lease to avoid clobbering concurrent changes:
   ```bash
   git push --force-with-lease
   ```

### Step 6: Push the Branch

Push the branch to remote, setting the upstream if this is the first push:

```bash
git push -u origin <branch-name>
```

### Step 7: Create or Update Pull Request

Check whether a PR already exists for the current branch.

**If no PR exists** — create one.

**If a PR already exists** — push the squashed commit (already done in Step 6) and update the PR description to reflect any new changes.

#### PR Title

Clear and concise summary of the change.

#### PR Description

Include:

##### Summary

Describe what changed and why.

##### Changes

List major modifications.

##### Breaking Changes

Before writing the PR description, scan the diff for breaking changes:

- Removed or renamed public exports, functions, classes, or types
- Changed method signatures (parameter names/types/order, return types)
- Removed or renamed configuration keys or environment variables
- Changed behavior that callers currently depend on (e.g. error types, event names, response shapes)
- Major version bumps in dependencies that themselves have breaking changes

If any breaking changes are found, add a `## ⚠️ Breaking Changes` section **at the top of the PR description**, before the Summary, listing each change and the migration path. Example:

```markdown
## ⚠️ Breaking Changes

- `EmitterService.emit()` now returns `Promise<void>` instead of `void` — callers must `await` it or `.catch()` explicitly.
- Removed `EMITTER_LOGGER` export — use `EmitterModule.forRoot({ logger })` instead.
```

If there are no breaking changes, omit this section entirely (do not add a "no breaking changes" note).

##### Risks

Describe any deployment or migration concerns.

##### Test Plan

Provide explicit verification steps.

Example:

```markdown
## Test Plan

- [ ] Run unit tests
- [ ] Run integration tests
- [ ] Verify login flow
- [ ] Verify error handling
- [ ] Validate API responses
- [ ] Confirm no regression issues
```

## Expected Output

Provide:

- Review summary (findings and fixes applied).
- Branch name and status.
- Commit hash.
- Pull Request URL.
- Conflict resolution summary (if applicable).
- Recommended next steps.

## Success Criteria

The branch should:

- Pass local review and linting.
- Be committed as a single squashed commit with a clear message.
- Be pushed to remote.
- Have an active Pull Request with a complete description and test plan.
- Be free of merge conflicts with the target branch.
- Be ready for reviewer feedback.
