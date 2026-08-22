import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = join(root, ".github", "workflows", "no-mistakes-required.yml");
const contributingPath = join(root, "CONTRIBUTING.md");

/**
 * The gate lives as an inline `run:` block so the whole file can be mirrored
 * across sibling repositories as one unit. Extract that exact block and execute
 * it, so these tests exercise what CI runs rather than a copy of it.
 *
 * Like `release-ci-exclusions.test.js`, this avoids a YAML dependency: the file
 * has exactly one `run: |` literal block, written at a fixed indent.
 */
function extractGateScript() {
  const lines = readFileSync(workflowPath, "utf8").split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^\s*run: \|\s*$/.test(line));
  assert.notEqual(startIndex, -1, "no-mistakes gate step has no `run: |` block");
  assert.equal(
    lines.filter((line) => /^\s*run: \|\s*$/.test(line)).length,
    1,
    "expected exactly one inline run block in the no-mistakes gate workflow",
  );

  const body = [];
  const indent = lines[startIndex].match(/^\s*/)[0].length + 2;
  const pad = " ".repeat(indent);
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (!line.startsWith(pad)) break;
    body.push(line.slice(indent));
  }
  const script = body.join("\n");
  assert.match(script, /^set -eu/, "extracted gate script does not start with the gate preamble");
  return `${script}\n`;
}

const scriptPath = join(mkdtempSync(join(tmpdir(), "nm-gate-")), "gate.sh");
writeFileSync(scriptPath, extractGateScript());

function hasCommand(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

// The gate is a bash script that parses JSON with jq, exactly as the
// ubuntu-latest runner it runs on does. Windows is excluded on purpose: the
// gate workflow never runs there, and Windows-native jq emits CRLF, which turns
// every parsed verdict into a false failure that says nothing about CI. Never
// skip on the platforms the gate does run on: on CI a silently skipped gate
// test is worse than no test. Locally, skip when jq is absent rather than
// failing a contributor's `pnpm test` over an unrelated missing tool.
const onWindows = process.platform === "win32";
const runnable = !onWindows && hasCommand("bash") && hasCommand("jq");
if (process.env.CI && !onWindows && !runnable) {
  throw new Error("CI must provide bash and jq to exercise the no-mistakes gate");
}

function runGate(body, headSha = HEAD_SHA) {
  const result = spawnSync("bash", [scriptPath], {
    env: { ...process.env, PR_BODY: body, PR_AUTHOR: "somedev", PR_NUMBER: "42", PR_HEAD_SHA: headSha },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

const SIGNATURE = "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
const ATTESTATION_PREFIX = "<!-- no-mistakes-pipeline-attestation:v1 ";
const ATTESTATION_SUFFIX = " -->";
const HEAD_SHA = "12df13109c6ad8d64646b85ac7170b23afe6e9bf";

/** A PR body shaped like the one no-mistakes writes. */
function prBody(attestationPayload) {
  const attestation =
    attestationPayload === undefined ? "" : `${ATTESTATION_PREFIX}${attestationPayload}${ATTESTATION_SUFFIX}\n\n`;
  return [
    "## What Changed\n\n- something\n",
    `## Pipeline\n\n${SIGNATURE}\n\n${attestation}`,
    "<details>\n<summary>Review</summary>\n\nok\n\n</details>\n",
  ].join("\n");
}

function attestation(steps, headSha = HEAD_SHA) {
  return JSON.stringify({ head_sha: headSha, steps: steps.map(([step, status]) => ({ step, status })) });
}

/** The step snapshot a healthy run produces when the PR body is written. */
const HEALTHY_STEPS = [
  ["intent", "completed"],
  ["rebase", "completed"],
  ["review", "completed"],
  ["test", "completed"],
  ["document", "completed"],
  ["lint", "completed"],
  ["push", "completed"],
  ["pr", "running"],
  ["ci", "pending"],
];

function withStatus(step, status) {
  return HEALTHY_STEPS.map(([name, current]) => (name === step ? [name, status] : [name, current]));
}

const skipReason = onWindows ? "the gate is a bash+jq script and never runs on Windows" : "bash and jq are required";

test("no-mistakes PR gate", { skip: runnable ? false : skipReason }, async (t) => {
  await t.test("accepts a body whose attestation completes review, test, and document", () => {
    const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)));
    assert.equal(code, 0, output);
    assert.match(output, /review, test, and document all completed/);
  });

  await t.test("still rejects a body with no no-mistakes signature", () => {
    const { code, output } = runGate("## Intent\n\nhand-written body\n");
    assert.equal(code, 1, output);
    assert.match(output, /was not raised through no-mistakes/);
    assert.match(output, /git push no-mistakes/);
  });

  await t.test("rejects a signed body with no attestation and names the required version", () => {
    const { code, output } = runGate(prBody());
    assert.equal(code, 1, output);
    assert.match(output, /no pipeline attestation/);
    assert.match(output, /no-mistakes >= 1\.46\.0 is required \(PR 670\)/);
  });

  // Every skip route no-mistakes has - `--skip`, a user skip at a gate, an
  // automatic pipeline skip, or a run that ran out of agent quota - lands on
  // the raw `skipped` status, and an unavailable agent surfaces as `failed`.
  for (const status of ["skipped", "failed", "running", "pending"]) {
    await t.test(`rejects an attestation whose test step is ${status}`, () => {
      const { code, output } = runGate(prBody(attestation(withStatus("test", status))));
      assert.equal(code, 1, output);
      assert.ok(output.includes(`records 'test' as '${status}'`), output);
    });
  }

  await t.test("rejects an attestation that omits a required step entirely", () => {
    const steps = HEALTHY_STEPS.filter(([name]) => name !== "document");
    const { code, output } = runGate(prBody(attestation(steps)));
    assert.equal(code, 1, output);
    assert.ok(output.includes("no 'document' step record"), output);
  });

  await t.test("rejects a required step recorded twice unless every record completed", () => {
    const steps = [...HEALTHY_STEPS, ["review", "skipped"]];
    const { code, output } = runGate(prBody(attestation(steps)));
    assert.equal(code, 1, output);
    assert.ok(output.includes("records 'review' as 'completed,skipped'"), output);
  });

  // v1 carries no skip sibling field, so `status` is the only skip channel
  // today. Fail closed if a later schema ever hangs a skip reason off an
  // otherwise-completed step instead of widening the gate silently.
  for (const marker of [
    { skip_reason: "quota exhausted" },
    { skipped: true },
    { agent_unavailable: true },
    { quota_exhausted: true },
  ]) {
    const key = Object.keys(marker)[0];
    await t.test(`rejects a completed step carrying a ${key} marker`, () => {
      const payload = JSON.stringify({
        head_sha: HEAD_SHA,
        steps: HEALTHY_STEPS.map(([step, status]) =>
          step === "review" ? { step, status, ...marker } : { step, status },
        ),
      });
      const { code, output } = runGate(prBody(payload));
      assert.equal(code, 1, output);
      assert.ok(output.includes(`skip indicator(s) [${key}]`), output);
    });
  }

  // Head binding: the attestation describes the commit no-mistakes ran on, so
  // an attestation naming any other commit says nothing about what is being
  // merged. A synchronize whose body was not rewritten by no-mistakes going red
  // is the contract, not a false positive.
  await t.test("accepts an attestation whose head_sha is the PR's current head", () => {
    const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS, HEAD_SHA)), HEAD_SHA);
    assert.equal(code, 0, output);
    assert.match(output, new RegExp(`Attestation head_sha: ${HEAD_SHA}`));
  });

  await t.test("rejects an attestation whose head_sha is not the PR's current head", () => {
    const staleSha = "0000000000000000000000000000000000000000";
    const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS, staleSha)), HEAD_SHA);
    assert.equal(code, 1, output);
    assert.match(output, /attestation is STALE for the current head/);
    assert.match(output, /Re-run 'git push no-mistakes' to refresh it/);
    assert.ok(output.includes(staleSha) && output.includes(HEAD_SHA), output);
  });

  await t.test("fails closed when the attestation carries no head_sha at all", () => {
    const payload = JSON.stringify({ steps: HEALTHY_STEPS.map(([step, status]) => ({ step, status })) });
    const { code, output } = runGate(prBody(payload), HEAD_SHA);
    assert.equal(code, 1, output);
    assert.match(output, /attestation is STALE for the current head/);
    assert.match(output, /Attestation head_sha: \(absent\)/);
  });

  await t.test("fails closed when the PR head sha is unavailable", () => {
    const { code, output } = runGate(prBody(attestation(HEALTHY_STEPS)), "");
    assert.equal(code, 1, output);
    assert.match(output, /attestation is STALE for the current head/);
    assert.match(output, /PR head sha: +\(absent\)/);
  });

  await t.test("fails closed on an attestation payload that is not valid JSON", () => {
    const { code, output } = runGate(prBody('{"head_sha":"abc","steps":[{"step":"review",'));
    assert.equal(code, 1, output);
    assert.match(output, /could not be parsed as JSON/);
  });

  await t.test("fails closed when the payload has no steps array", () => {
    const { code, output } = runGate(prBody('{"head_sha":"abc"}'));
    assert.equal(code, 1, output);
    assert.match(output, /could not be parsed as JSON/);
  });

  await t.test("fails closed when the attestation comment is never closed", () => {
    const body = `## Pipeline\n\n${SIGNATURE}\n\n${ATTESTATION_PREFIX}{"head_sha":"abc","steps":[]}\n`;
    const { code, output } = runGate(body);
    assert.equal(code, 1, output);
    assert.match(output, /no JSON payload could be extracted/);
  });

  await t.test("accepts a CRLF body", () => {
    const body = prBody(attestation(HEALTHY_STEPS)).replace(/\n/g, "\r\n");
    const { code, output } = runGate(body);
    assert.equal(code, 0, output);
  });
});

// CONTRIBUTING.md is the canonical public contract for the contributor workflow,
// including the minimum no-mistakes version contributors must run.
test("contributor workflow requires an attestation-capable no-mistakes version", () => {
  const contributing = readFileSync(contributingPath, "utf8");
  assert.match(contributing, /Workflow requires `no-mistakes` v1\.46\.0 or newer\./);
  assert.doesNotMatch(contributing, /requires `no-mistakes` v1\.30\.1 or newer/);
});
