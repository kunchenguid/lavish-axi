# Multiplexed event-stream protocol

Primary deliverable: a **domain-neutral multiplexed event-stream foundation**.
Lavish is the **first consumer**, integrated through a thin adapter.

## Layering

| Layer          | Module                                                       | Owns                                                                                                       |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Foundation     | `src/multiplexed-stream.js`, `src/multiplexed-stream-log.js` | consumer, stream_key, generation, lease, durable log, claim/publish/ack/retire, pressure, fencing          |
| Lavish adapter | `src/lavish-stream-adapter.js`                               | review_id ↔ stream_key, home_id ↔ consumer_id, prompts/failures/ended mapping, claim adoption, wire rename |
| CLI / HTTP     | `src/cli.js`, `src/server.js`                                | agent-facing commands and routes                                                                           |

The foundation schema and tests must not mention reviews, artifacts, prompts, feedback, layout warnings, or Lavish sessions.
A non-Lavish fixture exercises the foundation directly (see `test/multiplexed-stream.test.js`).

## Foundation vocabulary

| term           | meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `consumer_id`  | Unguessable token (capability). Mode 0600 on disk. Never on argv. |
| `stream_key`   | Opaque key for one logical stream among many on one subscription  |
| `generation`   | Monotonic fencing integer per consumer                            |
| `event_id`     | ULID                                                              |
| `log_position` | Monotonic per consumer                                            |
| lease          | Subscription liveness TTL                                         |

### Core operations

- `claim(consumer, generation, stream_key)` - serialized CAS (ownership + lease + optional identity alias)
- `publish(stream_key, { type, payload, end_state, idempotency_key })` - serialized with claim/retire
- `subscribe(consumer, generation)` - one multiplexed NDJSON stream for all claimed keys; admission serialized per consumer
- `acknowledge(consumer, generation, event_ids)` - idempotent; drains held volume when capacity frees
- `retire(consumer, generation, stream_key)` - refused while pending (unacked + held)

### Pressure (no silent loss)

When unacked counts hit per-stream or per-consumer bounds, **new volume is held** outside the deliverable log.
Existing unacked events **remain deliverable and acknowledgeable** so a consumer can always drain below the bound.
Held items drain into the log after acks free capacity.
Control/terminal events (`end_state` set, `backpressure`, `retention_overflow`, `oversize`) always enter the deliverable log.

### Wire (foundation)

Events: `schema: "multiplexed.event/1"` with `stream_key`, `consumer_id`, `type`, `payload`, `end_state`.
Control: `schema: "multiplexed.stream/1"`.

## Lavish adapter

Maps at the boundary only:

| Lavish                      | Foundation                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| `home_id` / `--home-file`   | `consumer_id`                                                              |
| `review_id` (session key)   | `stream_key`                                                               |
| prompts / artifact_failures | `payload` on `feedback` / `feedback_final`                                 |
| session end                 | `type: ended`, `end_state: "ended"`                                        |
| HTTP NDJSON to Firstmate    | renames to `lavish.event/1` with `review_id` / `home_id` / `artifact_path` |

### Commands

```sh
lavish-axi capabilities --json
lavish-axi home init --root <path> [--file <path>]
lavish-axi review claim --home-file <path> --generation <n> --review <id|file>
lavish-axi review retire --home-file <path> --generation <n> --review <id|file>
lavish-axi review list --home-file <path>
lavish-axi events subscribe --home-file <path> --generation <n> [--cursor <n>]
```

stdin: `{"ack":["..."]}`, `{"bye":true}`.

### Compatibility

- Unclaimed reviews: ordinary `poll` unchanged.
- Claimed reviews: poll always returns `status: claimed` (including ended). Exclusive stream transport.
- Claim adopts pre-claim session prompts/failures/ended into the log with idempotency keys, then clears session copies.
- Hardlink aliases: claim-time `dev+ino` check (`identity_alias` / `hardlink_alias`).

### Security

- Capability via `--home-file` only (0600). Never argv.
- Network position is not authentication.
- No payloads, tokens, or reviewer prose in logs/errors/telemetry.

### Persistence

- Foundation: `$LAVISH_AXI_STATE_DIR/multiplexed-stream.json` + `events/<consumerHash>/` (0600, fsync, torn-tail recovery).
- Lavish sessions: `state.json` atomic temp-and-rename + 0600; additive `state_version: 2` migration from 0.1.x.

Runtime limits, environment variables, aliases, and defaults are documented in the README's [Multiplexed event stream](../README.md#how-it-works) feature contract.
