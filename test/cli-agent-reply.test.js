import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { createOpenOutput, createPollOutput, getCommandHelp, resolveAgentReply, VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const STRUCTURED_REPLY = ["## What changed", "", "- **Phase 1 heading** done", "- next item", "", "1. ship it"].join(
  "\n",
);

function assertConciseFirstGuidance(text) {
  assert.match(text, /--agent-reply "<message for the user>"/);
  assert.match(text, /concise/i);
  assert.match(text, /Only when a longer reply is genuinely necessary/);
  assert.match(text, /--agent-reply-file/);
  assert.match(text, /blank-line paragraphs/);
  assert.match(text, /`- `/);
  assert.match(text, /`1\. `/);
  assert.match(text, /`## `/);
  assert.doesNotMatch(text, /prefer multiline/i);
}

function chromeSessionData(html) {
  const match = String(html).match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, "chrome page embeds lavish-session JSON");
  return JSON.parse(match[1]);
}

function assertStructuredAgentHtml(html) {
  assert.match(html, /<p class="chat-h">What changed<\/p>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>/);
  assert.match(html, /<ol>/);
  assert.doesNotMatch(html, /^<p>[^<]+<\/p>$/);
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdin?: string }} [options]
 */
function runCli(args, { cwd = REPO_ROOT, env = process.env, stdin } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EPIPE") throw error;
  });
  if (stdin !== undefined) {
    child.stdin.end(stdin);
  } else {
    child.stdin.end();
  }
  return new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("open and poll next_step keep --agent-reply concise-first and structure-when-long", () => {
  const open = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://127.0.0.1:4387/session/abc",
    status: "opened",
  });
  const poll = createPollOutput({
    file: "/tmp/artifact.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assertConciseFirstGuidance(open.next_step);
  assertConciseFirstGuidance(poll.next_step);
  assert.match(open.next_step, /lavish-axi poll --help|README/);
  assert.match(poll.next_step, /lavish-axi poll --help|README/);
});

test("poll help documents --agent-reply-file for longer Markdown and points at README's subset", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /--agent-reply "\.\.\."/);
  assert.match(help, /--agent-reply-file <path>/);
  assert.match(help, /concise/i);
  assert.match(help, /Only when a longer reply is genuinely necessary/);
  assert.match(help, /blank-line paragraphs/);
  assert.match(help, /`- `/);
  assert.match(help, /`1\. `/);
  assert.match(help, /`## `/);
  assert.match(help, /`-` reads stdin|`--agent-reply-file -`/);
  assert.match(help, /README/);
  assert.match(help, /Feedback controls/);
  assert.doesNotMatch(help, /prefer multiline/i);
  assert.match(help, /lavish-axi poll report\.html --agent-reply "Renamed the payment step\."/);
  assert.match(help, /lavish-axi poll report\.html --agent-reply-file reply\.md/);
});

test("resolveAgentReply keeps the inline --agent-reply string", async () => {
  assert.equal(
    await resolveAgentReply(["report.html", "--agent-reply", "Renamed the payment step."]),
    "Renamed the payment step.",
  );
  assert.equal(await resolveAgentReply(["report.html"]), null);
});

test("resolveAgentReply reads --agent-reply-file and stdin, and refuses the unsafe shapes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-agent-reply-resolve-"));
  try {
    const replyFile = path.join(dir, "reply.md");
    await writeFile(replyFile, STRUCTURED_REPLY, "utf8");

    assert.equal(await resolveAgentReply(["report.html", "--agent-reply-file", replyFile]), STRUCTURED_REPLY);
    assert.equal(
      await resolveAgentReply(["report.html", "--agent-reply-file", "-"], {
        stdin: Readable.from([STRUCTURED_REPLY]),
        stdinIsTTY: false,
      }),
      STRUCTURED_REPLY,
    );

    await assert.rejects(
      () => resolveAgentReply(["report.html", "--agent-reply", "hi", "--agent-reply-file", replyFile]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /cannot be combined|--agent-reply-file/);
        return true;
      },
    );
    await assert.rejects(
      () => resolveAgentReply(["report.html", "--agent-reply-file"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /--agent-reply-file/);
        return true;
      },
    );
    await assert.rejects(
      () => resolveAgentReply(["report.html", "--agent-reply-file", "--timeout-ms"]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /--agent-reply-file/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        resolveAgentReply(["report.html", "--agent-reply-file", "-"], {
          stdinIsTTY: true,
          stdin: new Readable({
            read() {
              throw new Error("must not read a TTY");
            },
          }),
        }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /stdin|TTY|--agent-reply-file/i);
        return true;
      },
    );
    await assert.rejects(
      () => resolveAgentReply(["report.html", "--agent-reply-file", path.join(dir, "missing.md")]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /--agent-reply-file/);
        return true;
      },
    );
    await writeFile(path.join(dir, "empty.md"), "  \n", "utf8");
    await assert.rejects(
      () => resolveAgentReply(["report.html", "--agent-reply-file", path.join(dir, "empty.md")]),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /empty/i);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll rejects over-limit agent reply files and stdin with an actionable error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-agent-reply-limit-"));
  const jsonLimitBytes = 2 * 1024 * 1024;
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ agent_reply: "" }));
  const oversizedReply = Buffer.alloc(jsonLimitBytes - envelopeBytes + 1, "a");
  const replyFile = path.join(dir, "oversized.md");
  await writeFile(replyFile, oversizedReply);
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: path.join(dir, "state"),
    LAVISH_AXI_TELEMETRY: "0",
  };
  try {
    for (const result of [
      await runCli(["poll", "report.html", "--agent-reply-file", replyFile], { env }),
      await runCli(["poll", "report.html", "--agent-reply-file", "-"], {
        env,
        stdin: oversizedReply.toString("utf8"),
      }),
    ]) {
      assert.notEqual(result.status, 0);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /Agent reply exceeds the 2 MB JSON request limit/);
      assert.match(output, /Shorten the reply/);
      assert.doesNotMatch(output, /RangeError|ERR_OUT_OF_RANGE|at readAgentReply/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll --agent-reply-file and stdin land multiline Markdown in the transcript and chrome html", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-agent-reply-e2e-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>", "utf8");
  const replyFile = path.join(dir, "reply.md");
  await writeFile(replyFile, STRUCTURED_REPLY, "utf8");
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    }).then((response) => response.json());

    const fromFile = await runCli(["poll", artifact, "--agent-reply-file", replyFile, "--timeout-ms", "50"], { env });
    assert.equal(fromFile.status, 0, fromFile.stderr || fromFile.stdout);

    const key = opened.key || sessionKey(artifact);
    const stored = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const fileEntry = stored.sessions[key].chat.at(-1);
    assert.equal(fileEntry.role, "agent");
    assert.equal(fileEntry.text, STRUCTURED_REPLY);
    assert.match(fileEntry.text, /\n/);

    const chrome = chromeSessionData(await fetch(`${base}/session/${key}`).then((response) => response.text()));
    const rendered = chrome.initialChat.at(-1);
    assert.equal(rendered.text, STRUCTURED_REPLY);
    assertStructuredAgentHtml(rendered.html);

    const fromStdin = await runCli(["poll", artifact, "--agent-reply-file", "-", "--timeout-ms", "50"], {
      env,
      stdin: STRUCTURED_REPLY,
    });
    assert.equal(fromStdin.status, 0, fromStdin.stderr || fromStdin.stdout);

    const afterStdin = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const stdinEntry = afterStdin.sessions[key].chat.at(-1);
    assert.equal(stdinEntry.text, STRUCTURED_REPLY);

    const chromeAfterStdin = chromeSessionData(
      await fetch(`${base}/session/${key}`).then((response) => response.text()),
    );
    assertStructuredAgentHtml(chromeAfterStdin.initialChat.at(-1).html);

    const concise = await runCli(
      ["poll", artifact, "--agent-reply", "Renamed the payment step.", "--timeout-ms", "50"],
      {
        env,
      },
    );
    assert.equal(concise.status, 0, concise.stderr || concise.stdout);
    const afterInline = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const inlineEntry = afterInline.sessions[key].chat.at(-1);
    assert.equal(inlineEntry.text, "Renamed the payment step.");
    assert.doesNotMatch(inlineEntry.text, /\n/);
    const chromeAfterInline = chromeSessionData(
      await fetch(`${base}/session/${key}`).then((response) => response.text()),
    );
    assert.equal(chromeAfterInline.initialChat.at(-1).html, "<p>Renamed the payment step.</p>");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
