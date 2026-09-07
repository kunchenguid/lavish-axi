# Fork delta

This fork was reviewed against `upstream/main` at `ca4c59d` on 2026-09-07.
The upstream sync retains four intentional policies and four compatibility
fixes. Other historical fork commits no longer change the effective tree.

The reviewed delta from `a7ddbba` through `ca4c59d` includes the overlapping
poll presence fix, reverse-proxy attachment fix, WebSocket event transport,
tracked-batch playbook guidance, and browser-disconnect poll release. Upstream
release commits through v0.1.67 were reviewed but their version changes were
not imported because this fork keeps its own release line.

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
and command-help output. The generated skill points at that live CLI guidance
instead of copying it.

### Require an explicit opt-in for Tailscale access

Upstream `443aaa9` automatically detects Tailscale and exposes the review
server on the machine's tailnet address whenever Tailscale is running. This
fork retains upstream's concrete-listener, MagicDNS, reconciliation, fallback,
and teardown implementation but enables it only when
`LAVISH_AXI_TAILSCALE=1` is set.

The default stays loopback-only because the review server is unauthenticated
and can read and serve local artifact files. Its owner is the activation gate
in `src/server.js`; `test/server.test.js` verifies both the disabled default and
the opted-in server behavior. `src/cli.js`, `README.md`, and `AGENTS.md` own the
matching runtime, user, and architecture guidance.

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

## Retained compatibility fixes

### Keep incomplete-publish warnings readable

`src/chrome-client.js` repairs the incomplete-publish warning assembled when
ht-ml.app returns an update key without a site id. Upstream still concatenates
the fragments as `thoughThe`. `test/chrome-client-queue.test.js` verifies the
rendered message through the chrome harness. Keep this fix until upstream
produces the same readable output.

### Keep browser E2E compatible across CLI versions

`test/attachment-upload.browser.test.js` accepts the nested JSON encoding
returned by supported `chrome-devtools-axi` versions before checking rendered
attachment errors. The opt-in browser suites use the Node test clock for fixed
delays because the CLI's numeric `wait` command is not reliable across those
versions, and they establish a page before asking newer versions to emulate a
viewport. These changes affect test compatibility only. Keep them while the
browser CLI used by this fork has these version-dependent contracts.

### Bound listener-shutdown connection probes

`test/server.test.js` gives the connection probe a one-second timeout when it
checks whether a listener closed. Without the bound, an unreachable address
can leave the suite waiting on the operating system's TCP timeout. This changes
test reliability only and does not alter server behavior.

### Verify the deliberate-stop banner is truthful

`test/event-transport.browser.test.js` checks the message an older review tab
renders when a deliberate stop leaves it open. Two truthful copies can legitimately
win: the deliberate-stop copy “Lavish was stopped. Reload after you start it again.”
that the old server sends with `reason: "stop"`, and the generic “The Lavish server
this page was connected to is no longer running. Reloading will work once it is
running again.” copy that the tab's legacy EventSource reconnect to the replacement
server delivers with a neutral `server-restarted` reason. Which one the test reads
depends on whether the read lands before or after that reconnect fires, so the
assertion accepts either and only forbids the false “updated” copy. This documents
the stable end state - the banner must never claim Lavish was updated - rather than
one transient event order. The same test retries a read-only DOM observation when
the browser CLI reports that the expected migration navigation destroyed its
execution context. The event must still appear within the original deadline. The
test reconstructs its pre-WebSocket "old build"
with `git archive` from this fork's pre-sync commit
`54b55875b1d5cda18a9fe11889ab604e97f73798`, which still shipped the SSE
transport, so the seven-tab regression stays self-contained in fork-only clones
where upstream's intermediate commits are absent.

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

1. Compare the effective fork diff from the previous reviewed upstream commit,
   not the raw ahead/behind count after a squash merge.
2. Recheck whether upstream now satisfies any retained policy.
3. Merge the source owners first and regenerate `skills/lavish/SKILL.md` with
   `pnpm run build:skill`.
4. Restore the fork's four release-owned files from its target branch.
5. Run `pnpm run check` before committing or pushing the sync.
6. After the sync has a durable published commit, advance any deployment that
   pins this fork by commit SHA and verify the installed runtime separately.
