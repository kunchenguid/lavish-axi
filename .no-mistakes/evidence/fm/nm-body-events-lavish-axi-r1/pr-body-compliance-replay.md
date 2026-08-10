# PR body compliance event replay

Target: `3bd80c71a42d12259071150527a74b03d46019d8`

Base: `966f4d58f769b0ceab5a8baf49982dba0fde4769`

## Verified pre-image and scope

```text
pre-image: ca417e9ff8453de9768e6737e46c875f1b5669c0
scope: exact two-hunk rollout; only .github/workflows/no-mistakes-required.yml changed
```

The replay executed the workflow's actual signature-check shell script for three
body events on the same PR and head. It also evaluated the target workflow's run
names and concurrency-group expression with distinct immutable GitHub run IDs.

## Same-head signed, unsigned, signed replay

```text
PR #558 body compliance - opened - event 41 (run 91001)
  group=no-mistakes-required-558-91001; signature=signed; check=PASS

PR #558 body compliance - edited - event 42 (run 91002)
  group=no-mistakes-required-558-91002; signature=unsigned; check=FAIL

PR #558 body compliance - edited - event 43 (run 91003)
  group=no-mistakes-required-558-91003; signature=signed; check=PASS
```

Every opened or edited body event received a distinct immutable group, so none
can replace another pending run. The check deterministically followed the body
signature state.

## Preserved head-change behavior

```text
synchronize=no-mistakes-required-558-head-change
reopened=no-mistakes-required-558-head-change
cancel-in-progress=true
```

The replay additionally asserted preservation of the `pull_request` read-only
boundary, the stable `PR must be raised via no-mistakes` check name, the exact
signature marker, all three bot exemptions, the four event triggers, and the
`main` branch filter.

## YAML and live CI status

Ruby's standard YAML parser successfully loaded the target workflow. At local
validation time, `gh-axi pr list --head fm/nm-body-events-lavish-axi-r1` and
`gh-axi run list --branch fm/nm-body-events-lavish-axi-r1` both returned zero
items. Repository CI therefore remains pending until the required PR is opened.

The supplied prior broad-check evidence reported one 30-second real-browser
timeout followed by an immediate isolated pass in 21 seconds. Because the
workflow-only diff cannot affect the browser product and the exact failing test
passed on immediate rerun, this is adjudicated as unrelated test flakiness, not
a failure of this change.
