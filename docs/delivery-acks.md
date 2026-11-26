# Delivery acks: seen, working, done per request

Design note for per-request delivery state in the Conversation panel. [README.md](../README.md) owns
the user-facing wording once this ships; [invariants.md](invariants.md) owns the stamping rules.

## Problem

A reviewer sends a note and cannot tell whether anything picked it up. Today the panel has one
session-wide signal - the `agent-presence` stream (`waiting` / `listening` / `working`) and the
"Working..." bubble - and a sent note looks identical whether it is sitting undelivered in
`state.json`, has been handed to a poll, or was answered an hour ago.

## What Lavish can already observe

Every state below is a fact the server records anyway. None of them asks the agent to do anything new.

| Signal                   | Where it is observed                                                                   | Means                                            |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `/api/:key/prompts` 200  | `SessionStore.queuePrompts` appends the note to `session.chat`                         | **Sent** - the server holds it for the next poll |
| no poll in `activePolls` | `computePresence` is `waiting`; the chrome already shows "Your agent is not listening" | nobody is there to receive it                    |
| `takeFeedback` succeeded | the store drained the batch for a poll; a poll that closed before the write undoes it  | **Seen** - the batch was handed to a poll        |
| artifact file changed    | chokidar `reload` for the session key after a delivery                                 | **Working** - the agent is editing the artifact  |
| `addAgentReply`          | `lavish-axi reply` / `poll --agent-reply`, or `/api/:key/agent-reply`                  | **Done** - the agent handed something back       |

Two of Wally's three acks ("I saw it", "I'm done") fall straight out of the existing protocol.
"I'm working on it" has no explicit message, but the file watcher sees the agent's saves. A request
that is answered without touching the artifact goes Seen -> Done with Working never ticked, which is
true, not a gap.

## States per request

```
queued ──send──> sent ──poll takes it──> seen ──artifact changes──> working ──agent reply──> done
 (tab)          (server)                 (agent)                    (agent)                  (agent)
```

- **queued**: in the tab only (dashed bubble). Unchanged.
- **sent**: a `role: "user"` chat entry with no `delivered_at`. The bubble says why it has not been
  seen, from the live presence the chrome already holds: "No agent is listening" (`waiting`),
  "Agent is busy; delivered on its next poll" (`working` / external listener), or "Delivering"
  while a poll is attached, which lasts milliseconds.
- **seen**: `delivered_at` set by `takeFeedback`.
- **working**: `working_at` set by the first artifact `reload` after delivery. Optional evidence.
- **done**: `done_at` set by the next agent reply.

## Storage and stamping rules

Stamps live on the chat entry (`session.chat[i]`), which already outlives the delivered prompt and is
what the chrome renders. `serializeChat` spreads the entry, so `initialChat` and `chat-sync` carry
the stamps with no new wire shape.

- **Delivery stamps by position, not by id.** `agentFacingPrompt` strips `prompt_id` from stored
  prompts at queue time, so ids are gone by the time `takeFeedback` runs. A take drains every
  pending prompt, and `queuePrompts` runs under the same store lock, so inside `takeFeedback` the
  set "user entries with no `delivered_at`" is exactly the batch being delivered. Each take increments
  `session.delivery_seq` and writes it as `delivered_seq` on the entries it stamps.
- **A disconnected poll un-stamps its own take only.** `restoreClosedFeedback` passes the take's
  `delivery_seq` back; `queuePrompts` in `restore` mode deletes the stamps on entries carrying that
  sequence (delete, not null - the restore tests assert `chat` deep-equals its pre-take shape). Notes
  queued in the window keep no stamp and are delivered, and stamped, by the next take. A restore that
  is refused (an attachment no longer resolves) cannot put the prompts back, and still takes the
  stamps off: the note is lost, and a Seen left on it would claim a delivery that never happened.
- **Working stamps delivered-and-not-done entries.** `markWorking(key)` runs on the `reload` event. A
  reload with nothing delivered changes nothing and writes nothing.
- **Done stamps delivered-and-not-done entries.** `addAgentReply` does it in the same write as the
  reply. An entry that was sent but never delivered is not marked done: the agent has not seen it.
- **Working and Done stay inside one review round.** Reopening an ended session records the last
  take so far as `session.closed_delivery_seq`, and neither stamp lands on an entry delivered at or
  before it. A note `lavish-axi end` left at Seen stays Seen: a later round's edit or reply is about
  that round's notes.
- **Every stamp change bumps `chat_revision`.** `syncChat` in the chrome accepts a same-revision sync
  only when it contains the displayed entries; a higher revision is what makes it take the
  authoritative replacement.
- `delivery_seq` is a session field, so `#upsertSessionLocked` carries it across a reopen like
  `chat_revision`. Stamps on `chat` entries survive because `chat` is carried verbatim.
- The server publishes `chat-sync` on the success path of a delivery (`finishFeedbackDelivery`) and
  after a restore, never on the destructive take itself, so a tab is not told Seen for a batch that
  is about to be put back.

## UI

Each sent user bubble gets a one-line receipt under its text: the three emoji of the Telegram ack
protocol this mirrors, 👀 Seen, 🛠️ Working, ✅ Done, each lighting up once its stamp exists and
shown greyed and dimmed until then, so the row always shows what is still to come. Every step
carries its label and time (or "not yet") as both `title` and `aria-label`, so hover and screen
readers say the word, not the glyph. Before 👀 lights, the row carries the honest reason from the
presence stream. The session-wide "Working..." bubble and
presence banner are unchanged; the receipt is the per-request view of the same facts.

A presence change rewrites only the undelivered line, the one part of the row that depends on it.
The rest of the bubble is left alone, so a thumbnail already replaced by "Image expired" stays so.

## CLI and API changes

None required for the automatic path. `lavish-axi poll`, `reply`, and the `/api/*` routes keep their
shapes. Two guidance strings gain one sentence each: `reply --help` and the poll `--agent-reply` row
in README say that a reply marks every request delivered to you as Done.

## Transcripts from before receipts

The positional rule is only true for sessions the receipt code has written from the start. An
existing `state.json` holds sessions whose user entries no take ever stamped; read naively, the
first poll after an upgrade would mark months-old notes Seen today and the next reply would mark
them Done. `readState`, the one load path every operation shares, therefore marks every user entry
of a session that has no `delivery_seq` key at all as `receipt: "none"` and persists that at once,
before any take can run. Those entries are skipped by every stamp helper and render no receipt row:
nothing was observed about them, and an empty row would read as "never seen".

## Open issues for Igor

- **A progress reply reads as Done.** `poll --agent-reply "still working on it"` stamps Done on
  every delivered note, exactly as it already clears the session-wide Working state. If a progress
  channel is wanted, it is a reply flag that posts without concluding; not built here.
- **Working means "the file changed", not "the agent is on your note".** An agent editing the
  artifact for an unrelated reason also ticks Working on every delivered, unanswered note. It is the
  honest automatic signal available; an explicit ack would be more precise and more work for agents.
- **`lavish-axi end` leaves notes at Seen.** Ending says the agent is finished with the review, not
  that each note was handled, so Done is not stamped. Say if the board should treat it as Done.

## Alternatives rejected

- **An explicit `lavish-axi ack <file> --working` command.** It is a new duty for every agent and
  harness, and the file watcher already supplies the signal for the common case. The upgrade path, if
  a progress channel is wanted, is a reply flag that posts a message without concluding the round;
  today `poll --agent-reply "still working"` stamps Done, exactly as it already clears Working.
- **Stamping on the poll's HTTP 200.** The take is destructive and the response can fail to write;
  stamping before the write and reverting on restore keeps one source of truth (`state.json`) and
  avoids a second bookkeeping path.
- **Matching delivered prompts to chat entries by `prompt_id`.** Would mean keeping ids on stored
  prompts and stripping at two boundaries plus the restore path; the positional rule under the lock is
  shorter and provably equivalent.
- **Marking Done when the agent ends the session.** `lavish-axi end` says the agent is finished with
  the review, not that it handled each note. Those stay Seen.
- **Session-level only.** That is today's presence stream; it cannot answer "did it see _this_".
