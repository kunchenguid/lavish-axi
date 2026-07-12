# Documentation consolidation validation

Validated target `e17fee6be38df483603b413dc77f81c593cd5a5e` against base `4f5585ce680a0f470700935001d5d7c2966117aa`.

## End-user CLI evidence

The npm package publishes `dist/cli.mjs` as the `lavish-axi` binary.
The following was observed from that packaged entry point with `node dist/cli.mjs --help` and `node dist/cli.mjs design`.

```text
Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing:
(1) if the user asked for a specific look or named design system, use that;
(2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system;
(3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN.
```

The help output also directs agents to run `lavish-axi design` and to state which of the three design sources they used and why.
The `design` command preserves the same rule and adds that the CDN is a fallback only after no user direction or subject-project design system is available.

## Consolidation checks

`DESIGN_PRIORITY_RULE` is the sole authored rule in `src/design-reference.js`.
The focused CLI test verifies the three semantics on that constant and exact containment in the home/skill hint, design summary, and design-command help.
`pnpm run build:skill` regenerated `skills/lavish/SKILL.md`, and `git diff --exit-code -- skills/lavish/SKILL.md` found no drift afterward.

The README retains the concise user-facing design-direction summary.
`AGENTS.md` now explicitly assigns user-facing contracts to README, agent runtime guidance to the runtime strings and generated skill, and architecture/invariants to AGENTS.

## Commands exercised

```sh
node --test test/cli-output.test.js
pnpm run build:skill
git diff --exit-code -- skills/lavish/SKILL.md
node dist/cli.mjs --help
node dist/cli.mjs design
```

No browser screenshot applies because the affected end-user surface is text-based CLI and Markdown guidance rather than a rendered product UI.
