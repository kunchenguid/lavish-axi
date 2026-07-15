# Foreground poll and Send & End evidence

This transcript uses a synthetic artifact and synthetic feedback only.
Workspace paths and session identifiers are normalized so no private review content is retained.

## 1. Open output establishes the wake-path contract

Command:

```console
$ LAVISH_AXI_NO_OPEN=1 node bin/lavish-axi.js <artifact.html> --no-open
```

Relevant actual output:

```text
session:
  file: <artifact.html>
  url: "http://127.0.0.1:<port>/session/<session-key>"
  status: opened
next_step: "... Keep the poll in the foreground by default and let it return the feedback directly to the agent. A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent. Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive. If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor. Do not tell the user the artifact is being monitored until that wake path is live. ..."
```

## 2. A foreground poll remains attached and receives final feedback

The poll was launched as the foreground command in a tracked execution cell.
It immediately printed the wait banner and stayed attached:

```console
$ node bin/lavish-axi.js poll <artifact.html>
[lavish-axi] Long-polling for user feedback or layout_warnings on <artifact.html>. This stays silent until the user sends feedback, ends the session, or the browser reports fresh layout_warnings - leave it running.
```

The browser-equivalent prompt request atomically submitted one sanitized prompt with `endSession: true`.
The same foreground poll resumed with:

```text
session:
  file: <artifact.html>
  status: feedback
  session_ended: true
  ended_by: user
dom_snapshot: ""
prompts[1]{uid,prompt,selector,tag,text}:
  evidence-1,Sanitized final feedback,h1,h1,Foreground poll wake-path verification
next_step: This was the last feedback before the user ended the session. Stop polling <artifact.html> and do not reopen it - deliver any remaining updates directly in this conversation instead.
```

## 3. Final feedback is delivered exactly once and plain reopen is refused

Re-running poll returned only the ended state, with no prompt payload:

```text
session:
  file: <artifact.html>
  status: ended
  ended_by: user
next_step: The user ended this Lavish Editor session. Stop polling <artifact.html> - do not run `lavish-axi <artifact.html>` to reopen it.
```

A plain open then preserved the user's end decision:

```text
session:
  file: <artifact.html>
  url: "http://127.0.0.1:<port>/session/<session-key>"
  status: user-ended
next_step: "The user explicitly ended this Lavish Editor session from the browser, so `lavish-axi <artifact.html>` did not reopen it. Do not reopen unless the user asks for further review ..."
```

This demonstrates the actual CLI lifecycle required by the public skill: observable foreground wake, one final feedback delivery, polling termination, and no uninvited reopen.
