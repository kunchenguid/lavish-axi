import test from "node:test";

import { runIssue352Mutation } from "../scripts/check-issue-352-mutation.js";

const acceptance = process.env.ISSUE_352_ACCEPTANCE === "1";

test("352-M01", { skip: !acceptance, timeout: 600_000 }, async (t) => {
  const result = await runIssue352Mutation();

  await t.test("original-green", (child) => {
    child.plan(1);
    child.assert.equal(result.originalGreen, true);
  });
  await t.test("sibling-review-unavailable", (child) => {
    child.plan(1);
    child.assert.equal(result.siblingReviewUnavailable, true);
  });
  await t.test("intended-assertion-red", (child) => {
    child.plan(1);
    child.assert.equal(result.intendedAssertionRed, true);
  });
  await t.test("restored-green", (child) => {
    child.plan(1);
    child.assert.equal(result.restoredGreen, true);
  });
  await t.test("outside-repo-cleanup", (child) => {
    child.plan(3);
    child.assert.equal(result.outsideRepo, true);
    child.assert.equal(result.cleanup, true);
    child.assert.equal(result.workingTreeUnchanged, true);
  });
});
