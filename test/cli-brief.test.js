import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

// Exercise the real CLI and SDK serializer, but never contact an existing server,
// launch a process, open a browser, or inspect the host's network interfaces.
const PRELOAD = `
import http from "node:http";
import childProcess from "node:child_process";
import os from "node:os";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
http.get = () => {
  const request = new EventEmitter();
  request.destroy = () => {};
  request.setTimeout = () => request;
  queueMicrotask(() => request.emit("error", new Error("fixture: no server")));
  return request;
};
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[method] = () => { throw new Error("unexpected external process: " + method); };
}
os.networkInterfaces = () => ({});
syncBuiltinESMExports();
`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-brief-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const run = (args) => {
    const result = spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(PRELOAD)}`, BIN, ...args],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: dir,
          LAVISH_AXI_STATE_DIR: stateDir,
          LAVISH_AXI_TELEMETRY: "0",
          LAVISH_AXI_HOST: "127.0.0.1",
          LAVISH_AXI_LINK_HOST: "127.0.0.1",
        },
      },
    );
    assert.ifError(result.error);
    return result;
  };
  return { dir, stateDir, run };
}

function assertPointer(stdout) {
  assert.match(stdout, /lavish-axi playbook <id>/);
  assert.match(stdout, /lavish-axi design/);
}

function sessionsBlock(stdout) {
  const start = stdout.indexOf("sessions[");
  assert.notEqual(start, -1, stdout);
  const lines = stdout.slice(start).split("\n");
  const end = lines.findIndex((line, index) => index > 0 && !line.startsWith("  "));
  return lines.slice(0, end < 0 ? undefined : end).join("\n");
}

test("--brief emits every visible session unchanged, without the reference payload", async (t) => {
  const { dir, stateDir, run } = await fixture(t);
  // Initialize only disposable state; this does not start a server.
  const initialized = run(["--brief"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const sessions = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => {
      const key = String(index);
      return [
        key,
        {
          key,
          file: path.join(index % 2 ? dir : "/other-project", `artifact-${index}.html`),
          status: index === 39 ? "ended" : index % 2 ? "feedback" : "open",
          url: `http://127.0.0.1:29999/session/${key}`,
          pending_prompts: index % 2,
          prompts: index % 2 ? [{ prompt: "Review this" }] : [],
          chat: [],
          delivery_seq: 0,
          updated_at: index,
        },
      ];
    }),
  );
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ sessions }));
  const full = run([]);
  const brief = run(["--brief"]);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(brief.status, 0, brief.stderr);
  assert.equal(sessionsBlock(brief.stdout), sessionsBlock(full.stdout));
  for (let index = 0; index < 39; index++) {
    assert.ok(brief.stdout.includes(`artifact-${index}.html`));
  }
  assert.doesNotMatch(brief.stdout, /artifact-39\.html/);
  assert.match(brief.stdout, /sessions\[39\]/);
  assertPointer(brief.stdout);
  for (const field of ["description:", "visual_guidance[", "playbooks["]) {
    assert.ok(full.stdout.includes(field), full.stdout);
    assert.ok(!brief.stdout.includes(field), brief.stdout);
  }
  assert.ok(brief.stdout.length < full.stdout.length);
});

test("--brief explicitly emits an empty sessions block and guidance", async (t) => {
  const { run } = await fixture(t);
  const result = run(["--brief"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sessions\[0\]/);
  assertPointer(result.stdout);
});

test("--brief reports unreadable session state, not a successful empty list", async (t) => {
  const { stateDir, run } = await fixture(t);
  const initialized = run(["--brief"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(path.join(stateDir, "state.json"), "{invalid json");
  const result = run(["--brief"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /sessions\[0\]/);
  assert.match(result.stdout, /error:/);
  assert.match(result.stdout, /SESSION_LIST_ERROR/);
  assertPointer(result.stdout);
});

test("--brief reports state-directory initialization failures with sessions and guidance", async (t) => {
  const { stateDir, run } = await fixture(t);
  await writeFile(stateDir, "not a directory");
  const result = run(["--brief"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /sessions\[0\]/);
  assert.match(result.stdout, /error:/);
  assertPointer(result.stdout);
});

test("top-level help keeps full reference guidance without listing sessions", async (t) => {
  const { run } = await fixture(t);
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /visual_guidance\[/);
  assert.match(result.stdout, /playbooks\[/);
  assert.doesNotMatch(result.stdout, /sessions\[/);
});

test("the default Copilot hook still invokes bare lavish-axi, without installing a hook", async () => {
  const { createCopilotCliAmbientContextScript } = await import("../src/cli.js");
  const calls = [];
  const output = [];
  runInNewContext(createCopilotCliAmbientContextScript(), {
    require(name) {
      assert.equal(name, "node:child_process");
      return {
        spawnSync(command, args) {
          calls.push([command, Array.from(args)]);
          return { status: 0, stdout: "full context" };
        },
      };
    },
    console: { log: (message) => output.push(JSON.parse(message)) },
  });
  assert.deepEqual(calls, [["lavish-axi", []]]);
  assert.equal(output[0].additionalContext, "## AXI ambient context: lavish-axi\nfull context");
});
