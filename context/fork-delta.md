# Fork delta

This fork was reviewed against `upstream/main` at `3b2c10f` on 2026-08-21.
The upstream merge retains three intentional differences. Other historical fork
commits no longer change the effective tree.

## Retained policies

### Use the reviewed `lavish-axi` command on `PATH`

Commit `ea672f0` changed the generated public skill from an on-demand
`npx -y lavish-axi` invocation to the `lavish-axi` command supplied by the
environment. This lets managed installations pin and review the executable
instead of downloading whichever package version resolves at invocation time.

Keep this policy while the fork is distributed through a reviewed wrapper or
pinned installation. Its owner is `src/skill.js`; `skills/lavish/SKILL.md` is
generated from it. `README.md`, `AGENTS.md`, and `test/skill.test.js` describe
and verify the policy.

The original commit also removed nested Hermes metadata because that shape did
not satisfy the Agent Skills frontmatter contract. Upstream now uses flat,
string-valued Hermes fields that pass the validator. The sync restores those
fields while retaining the fork's `upstream` provenance field.

### Require explicit authorization before hosted sharing

Commit `ea672f0` also changed agent-facing `share` guidance to require an
explicit user request before publishing an artifact outside the local machine.
This remains necessary because `share` sends content to a third-party service
and creates a public page by default unless the user supplies a password.

Keep this policy unless the publication boundary changes. Its owner is the
runtime guidance in `src/cli.js`; `test/cli-output.test.js` verifies both home
and command-help output. The generated skill inherits the same guidance.

### Keep release metadata on the fork's release line

The sync imports upstream implementation commits but is not itself a release.
Keep `CHANGELOG.md`, `.release-please-manifest.json`, `package.json`, and
`plugin.json` at the versions from this fork's `main` branch. The fork's
Release Please workflow owns all four files and will advance them together when
the synced code is released here.

This also keeps upstream release commits from making an ordinary sync pull
request modify the two generated files rejected by the repository's generated
file guard. Re-evaluate this policy only if the fork stops publishing its own
release line or adopts an upstream-version mirroring workflow.

## Superseded commits

The following commits reduced false positives in the former automatic layout
audit:

- `75e69d2` checked rendered text fragments and downgraded contained overhang.
- `884f785` skipped unnecessary text walks for scrollable or truncated boxes.
- `65fb0b4` updated the related architecture notes.
- `896e317` corrected optional-parameter types for the new helpers.

The v0.1.48 upstream merge replaced that implementation with the passive layout
warning inbox and conservative diagnostic lifecycle. A diff from the v0.1.48
tag to the pre-sync fork shows no surviving code from these commits. Do not
reapply them during later upstream syncs. Revisit the old approach only if the
current audit reproduces the same false positives and a new test demonstrates
the regression.

Commit `3a3b41d` removed a test for the old installed-copy fallback. That removal
is now part of the retained PATH-only policy tests and needs no separate port.

## Future sync check

Before each upstream merge:

1. Compare the effective fork diff from the previous upstream merge or tag.
2. Recheck whether upstream now satisfies either retained policy.
3. Merge the source owners first and regenerate `skills/lavish/SKILL.md` with
   `pnpm run build:skill`.
4. Restore the fork's four release-owned files from its target branch.
5. Run `pnpm run check` before committing or pushing the sync.
