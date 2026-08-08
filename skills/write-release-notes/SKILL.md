---
name: write-release-notes
description: Turn a range of git commits into release notes grouped by change type, with breaking changes called out first. Use when the user asks for release notes, a changelog entry, or a summary of what shipped.
license: MIT
metadata:
  version: "1.0.0"
---

# Write release notes

This skill needs no MCP server. It exists in this plugin to make one point
concrete: the two portable component types are independent. A client that
supports skills but not MCP still gets full value out of this file, and this
skill still works if `mcp.json` is removed.

## Workflow

1. Collect the commits:

   ```bash
   node "$PLUGIN_ROOT/skills/write-release-notes/scripts/changelog.mjs" <from-ref> <to-ref>
   ```

   The script emits JSON grouped by Conventional Commit type. It reads `git log`
   from the current directory, so run it from inside the repository you are
   releasing — not from the skill directory.

2. Draft the notes in this order — breaking changes first, because that is the
   only section a reader cannot afford to skim past:

   - **Breaking changes** — what broke, and the migration in one sentence.
   - **Features** — user-visible capability, phrased as what the user can now do.
   - **Fixes** — the symptom that is gone, not the internal cause.
   - **Other** — chores, docs, refactors. Collapse aggressively.

3. Drop sections that are empty. An empty heading reads as an oversight.

## Rules

- Write for someone who did not read the diff. `Fix null deref in resolver`
  becomes `Fix crash when a config file had no environments block`.
- One line per change. Group duplicates rather than listing every commit.
- Never invent an issue or PR number. If the commit has no reference, omit it.
- If the range contains commits that do not parse as Conventional Commits, the
  script returns them under `other` — read them yourself before classifying.
