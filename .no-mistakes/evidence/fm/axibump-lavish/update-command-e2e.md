# `lavish-axi update` E2E evidence

Environment for these checks:

```sh
LAVISH_AXI_STATE_DIR=.tmp-lavish-state
LAVISH_AXI_TELEMETRY=0
npm_config_cache=.tmp-npm-cache
```

## SDK reserved `update` command help

Command:

```sh
node dist/cli.mjs update --help
```

Output:

```toon
command: update
description: Upgrade `cli.mjs` to the latest published npm version
flags:
  "--check": Report current vs latest and exit without installing
examples[2]: cli.mjs update,cli.mjs update --check
```

## SDK updater package resolution

Command:

```sh
node dist/cli.mjs update --check
```

Output:

```toon
update:
  package: lavish-axi
  current: 0.1.31
  latest: 0.1.31
  available: false
```

## Plain update command no-op when current is latest

Command:

```sh
npm_config_prefix=.tmp-npm-prefix node dist/cli.mjs update
```

Output:

```text
update: lavish-axi is already on the latest version (0.1.31)
```

## Existing bare HTML-file routing still opens

Additional environment:

```sh
LAVISH_AXI_PORT=54387
LAVISH_AXI_NO_OPEN=1
```

Command:

```sh
node dist/cli.mjs --no-open .tmp-e2e/report.html
```

Output:

```toon
session:
  file: /Users/kunchen/.no-mistakes/worktrees/ea3c5e639a16/01KW3MD88D568XN6G78KZ3MYR2/.tmp-e2e/report.html
  url: "http://127.0.0.1:54387/session/32acd62bfc5b663b"
  status: opened
next_step: "Do not respond to the user just yet. Now you must run `lavish-axi poll /Users/kunchen/.no-mistakes/worktrees/ea3c5e639a16/01KW3MD88D568XN6G78KZ3MYR2/.tmp-e2e/report.html`. This command long-polls until the user sends feedback, ends the session, or the real browser reports layout_warnings from the in-iframe layout audit, and it stays silent the whole time - that is normal, never kill it. If layout_warnings arrive, fix overflow, clipped text, or overlapping unreadable content and re-check before involving the human. Do not pass --timeout-ms during normal agent use. If your harness limits how long a foreground command may run, run the poll as a background task and wait for it to finish; if the poll still gets killed or times out, just re-run it - queued feedback is never lost. After applying feedback, run `lavish-axi poll /Users/kunchen/.no-mistakes/worktrees/ea3c5e639a16/01KW3MD88D568XN6G78KZ3MYR2/.tmp-e2e/report.html --agent-reply \"<message for the user>\"` without --timeout-ms to show your response in Lavish Editor and wait for more feedback."
```

Stop command:

```sh
node dist/cli.mjs stop --port 54387
```

Output:

```toon
server:
  status: stopped
  port: 54387
```
