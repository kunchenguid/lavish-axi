import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  legacyStateDir,
  LOOPBACK_HOST,
  linkHost,
  migrateLegacyStateDir,
  stateDir,
  xdgDataHome,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors LAVISH_AXI_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LAVISH_AXI_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the concrete primary listener for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0:0:0:0:0:0:0:0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[0:0:0:0:0:0:0:0]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::ffff:0.0.0.0" }), LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LAVISH_AXI_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "0.0.0.0", LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

test("xdgDataHome honors XDG_DATA_HOME and falls back to ~/.local/share", () => {
  assert.equal(xdgDataHome({ XDG_DATA_HOME: "/custom/data" }), "/custom/data");
  assert.equal(xdgDataHome({ XDG_DATA_HOME: "  " }), path.join(os.homedir(), ".local", "share"));
  assert.equal(xdgDataHome({}), path.join(os.homedir(), ".local", "share"));
});

test("stateDir prefers LAVISH_AXI_STATE_DIR, then XDG_DATA_HOME, then ~/.local/share/lavish-axi", () => {
  assert.equal(stateDir({ LAVISH_AXI_STATE_DIR: "/explicit/state" }), "/explicit/state");
  assert.equal(stateDir({ XDG_DATA_HOME: "/custom/data" }), path.join("/custom/data", "lavish-axi"));
  assert.equal(stateDir({}), path.join(os.homedir(), ".local", "share", "lavish-axi"));
});

test("legacyStateDir is the pre-XDG ~/.lavish-axi dotfile", () => {
  assert.equal(legacyStateDir("/home/user"), path.join("/home/user", ".lavish-axi"));
  assert.equal(legacyStateDir(), path.join(os.homedir(), ".lavish-axi"));
});

test("migrateLegacyStateDir moves an existing legacy directory into the new XDG location", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lavish-axi-home-"));
  try {
    const legacy = path.join(home, ".lavish-axi");
    const dataHome = path.join(home, "xdg-data");
    await mkdir(legacy, { recursive: true });
    await mkdir(path.join(legacy, "attachments"), { recursive: true });
    await writeFile(path.join(legacy, "state.json"), '{"sessions":{}}');
    await writeFile(path.join(legacy, "attachments", "a.png"), "img");

    const env = { XDG_DATA_HOME: dataHome };
    const messages = [];
    const migrated = await migrateLegacyStateDir(env, { homeDir: home, log: (msg) => messages.push(msg) });
    const target = stateDir(env, home);

    assert.equal(migrated, true);
    assert.equal(await readFile(path.join(target, "state.json"), "utf8"), '{"sessions":{}}');
    assert.equal(await readFile(path.join(target, "attachments", "a.png"), "utf8"), "img");
    await assert.rejects(readFile(path.join(legacy, "state.json"), "utf8"));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /migrated state from/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrateLegacyStateDir is a no-op when the legacy dir is absent or the target already exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lavish-axi-home-"));
  try {
    const dataHome = path.join(home, "xdg-data");
    const env = { XDG_DATA_HOME: dataHome };

    // No legacy directory at all.
    assert.equal(await migrateLegacyStateDir(env, { homeDir: home }), false);
    assert.equal(await pathExists(path.join(dataHome, "lavish-axi")), false);

    // Legacy exists, but so does the target - never overwrite existing new-location state.
    const legacy = path.join(home, ".lavish-axi");
    const target = path.join(dataHome, "lavish-axi");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "old.txt"), "old");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "new.txt"), "new");

    assert.equal(await migrateLegacyStateDir(env, { homeDir: home }), false);
    assert.equal(await pathExists(path.join(legacy, "old.txt")), true);
    assert.equal(await pathExists(path.join(target, "new.txt")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrateLegacyStateDir never runs when LAVISH_AXI_STATE_DIR is set explicitly", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lavish-axi-home-"));
  try {
    const legacy = path.join(home, ".lavish-axi");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "state.json"), "{}");
    const explicit = path.join(home, "explicit-state");

    assert.equal(await migrateLegacyStateDir({ LAVISH_AXI_STATE_DIR: explicit }, { homeDir: home }), false);
    assert.equal(await pathExists(explicit), false);
    assert.equal(await pathExists(path.join(legacy, "state.json")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function pathExists(target) {
  try {
    await readFile(target);
    return true;
  } catch (err) {
    if (err?.code === "EISDIR") return true;
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
