# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review/test/lint pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check (`Require no-mistakes`) runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes.
It also requires the machine-readable pipeline attestation that no-mistakes >= 1.46.0 writes next to that signature: the `review`, `test`, and `document` steps must all be recorded as `completed`, and the attested `head_sha` must be the PR's current head.
The check runs on PR body events (opened, edited, reopened), not on pushes, so a commit pushed after the pipeline ran leaves the last verdict standing until the body is rewritten; `git push no-mistakes` again so the body carries an attestation for the new head.
The release and dependency bots are exempt so their automation keeps working, but regular contributor PRs without the signature and a current attestation will not be reviewed or merged.

## Workflow

Workflow requires `no-mistakes` v1.46.0 or newer.
Earlier versions can route pushes to a fork, but they do not write the pipeline attestation required by this repository's PR gate.

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:kunchenguid/lavish-axi.git`).
2. Create a branch and make your changes.
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/lavish-axi.git`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`:

   ```sh
   git push no-mistakes
   ```

6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this parent repo for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Run `pnpm run check` before pushing.
- Do not reformat repo-provided `.agents/` skill content; `.prettierignore` excludes it intentionally.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- User-facing telemetry docs should stay minimal: anonymous usage telemetry, no sensitive content, and `LAVISH_AXI_TELEMETRY=0` opt-out.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
