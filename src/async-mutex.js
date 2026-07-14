// A minimal promise-chain mutex. The attachment lifecycle has three writers that
// race across async boundaries - upload finalize, `/prompts` resolve+persist, and
// the reference-aware sweep/delete - and a reference acquired after the sweeper
// snapshots referenced ids but before it deletes would otherwise point at a file
// the sweeper is about to remove. Serializing all three through ONE shared lock
// closes that window: the sweep either runs fully before a queue (and its delete
// then loses the race cleanly, so resolveAttachment just drops the id) or fully
// after (and the id is in the snapshot, so the file is kept).
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
