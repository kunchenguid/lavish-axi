# Contributing

Thanks for wanting to contribute.

Direct pull requests validated by repository-native tests and GitHub CI are the routine default.
The captain still decides when a pull request is approved to merge.

Use [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) only when:

- the captain explicitly requests it; or
- the task changes security, privacy, authentication or authorization, destructive data or schema behavior, billing, production deployment or infrastructure, or another broad/high-blast-radius subsystem.

Routine docs, tests, CI/configuration, narrow UI changes, and small bounded fixes must not invoke `no-mistakes` solely because they are ship work.

## Workflow

1. Fork and clone the repo.
2. Create a branch and make your changes.
3. Run the repository-native validation:

   ```sh
   pnpm run check
   ```

4. Commit your changes and push the branch to your fork.
5. Open a pull request targeting `main`.
6. Address GitHub CI failures and review feedback. The captain decides whether to merge.

When the risk policy above requires `no-mistakes`, follow its [quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) instead of the direct-push steps.

## Repo Conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Run `pnpm run check` before pushing.
- Do not reformat repo-provided `.agents/` skill content; `.prettierignore` excludes it intentionally.
- Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json`.
- User-facing telemetry docs should stay minimal: anonymous usage telemetry, no sensitive content, and `LAVISH_AXI_TELEMETRY=0` opt-out.

## Questions

Open an issue, or talk to me on [Discord](https://discord.gg/Wsy2NpnZDu).
