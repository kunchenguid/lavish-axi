# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review/test/lint pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check (`Require no-mistakes`) runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes.
The release and dependency bots are exempt so their automation keeps working, but regular contributor PRs without the signature will not be reviewed or merged.

## Workflow

1. Fork the repo and clone your fork.
2. Create a branch and make your changes.
3. Initialize the gate in the repo once: `no-mistakes init`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`:

   ```sh
   git push no-mistakes
   ```

6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it forwards the push upstream and opens the PR for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Use TDD for bug fixes and new features.
- Run `npm run check` before pushing.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- User-facing telemetry docs should stay minimal: anonymous usage telemetry, no sensitive content, and `LAVISH_AXI_TELEMETRY=0` opt-out.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
