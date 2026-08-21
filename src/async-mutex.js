// A minimal promise-chain mutex. `SessionStore` owns one instance and serializes
// TWO overlapping classes of race across async boundaries under it:
//   1. State consistency: every `state.json` read-modify-write (queuePrompts,
//      takeFeedback, recordLayoutWarnings, upsertSession, endSession, addAgentReply).
//      A read that awaits before writing could otherwise lose a concurrent mutator's
//      write - a poll's takeFeedback clearing prompts while queuePrompts holds a
//      stale pre-resolve snapshot, which then writes the snapshot back (E1).
//   2. Attachment lifecycle: upload finalize, `/prompts` resolve+persist,
//      reference-counted delete, and the reference-aware sweep. Without one shared
//      lock, a prompt could acquire a reference after delete/sweep snapshots
//      referenced ids but before it removes the file. Serializing them closes that
//      window: removal either finishes first and prompt resolution rejects the send
//      batch, or resolution finishes first and the new reference protects the file.
// The server routes its attachment disk sections through `store.runExclusive` so both
// classes share the SAME lock (D5 stays consistent with state writes).
//
// `runExclusive` returns the callback's own result/rejection to the caller while
// keeping the internal chain alive regardless of outcome, so one failed critical
// section never wedges the lock for the next caller.
export class AsyncMutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  runExclusive(fn) {
    const run = this._tail.then(() => fn());
    this._tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
