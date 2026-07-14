// A minimal promise-chain mutex. Four attachment lifecycle operations race across
// async boundaries: upload finalize, `/prompts` resolve+persist, reference-counted
// delete, and the reference-aware sweep. Without one shared lock, a prompt could
// acquire a reference after delete/sweep snapshots referenced ids but before it
// removes the file. Serializing all four closes that window: removal either
// finishes first and prompt resolution rejects the send batch, or resolution
// finishes first and the new reference protects the file.
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
