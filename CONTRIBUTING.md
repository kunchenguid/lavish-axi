# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review/test/lint pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check (`Require no-mistakes`) runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes.
The release and dependency bots are exempt so their automation keeps working, but regular contributor PRs without the signature will not be reviewed or merged.

## Workflow

Fork routing requires `no-mistakes` v1.30.1 or newer.

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
- Keep `.agents/skills/lavish-design/SKILL.md` marked with `metadata.internal: true`; it is a maintainer-only brand skill and must not become part of public skill discovery.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- User-facing telemetry docs should stay minimal: anonymous usage telemetry, no sensitive content, and `LAVISH_AXI_TELEMETRY=0` opt-out.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
