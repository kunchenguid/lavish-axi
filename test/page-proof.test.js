import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  loadPageProofKey,
  normalizePageIdentity,
  signPageProof,
  verifyPageProof,
  signHistoricalDestination,
  verifyHistoricalDestination,
  windowsPageProofAcl,
} from "../src/artifact-page.js";

const execFileAsync = promisify(execFile);
// Windows runs the production shell. Elsewhere PowerShell 7, when installed, still executes the
// script's operation dispatch before it reaches any Windows-only API.
const ACL_SHELL = process.platform === "win32" ? "powershell.exe" : "pwsh";
const ACL_SHELL_AVAILABLE =
  spawnSync(ACL_SHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { windowsHide: true })
    .status === 0;

test("historical receipts are bounded and domain separated, binding root, entry, session, route, URL and document", () => {
  const key = Buffer.alloc(32, 8);
  const destination = { page: "a.html", route: "alias.html", url: "/artifact/session/alias.html?author=1#part" };
  const args = [key, "session", "/root", "/root/entry.html", destination, "document-a"];
  const receipt = signHistoricalDestination(...args);
  assert.equal(verifyHistoricalDestination(...args, receipt), true);
  /** @type {[number, any][]} */
  const mutations = [
    [0, Buffer.alloc(32, 9)],
    [1, "other"],
    [2, "/other"],
    [3, "/root/other.html"],
    [4, { ...destination, page: "b.html" }],
    [4, { ...destination, route: "a.html" }],
    [4, { ...destination, url: destination.url + "-changed" }],
    [5, "document-b"],
  ];
  for (const [index, replacement] of mutations) {
    const changed = [...args];
    changed[index] = replacement;
    assert.equal(verifyHistoricalDestination(...changed, receipt), false);
  }
  assert.equal(verifyHistoricalDestination(...args, signPageProof(key, "session", "/root", "a.html")), false);
  assert.equal(verifyHistoricalDestination(...args, receipt + "="), false);
  assert.equal(
    signHistoricalDestination(
      key,
      "session",
      "/root",
      "/root/entry.html",
      { ...destination, url: "a".repeat(65537) },
      "document-a",
    ),
    null,
  );
  assert.equal(
    signHistoricalDestination(key, "session", "/root", "/root/entry.html", destination, "a".repeat(257)),
    null,
  );
});

test(
  "literal POSIX entry proof binds exact saved identity without authorizing sibling syntax",
  { skip: path.sep !== "/" },
  () => {
    const key = Buffer.alloc(32, 9);
    const file = "/tmp/root/report\\final.html";
    const page = path.basename(file);
    const proof = signPageProof(key, "session", "/tmp/root", page, file);
    assert.equal(normalizePageIdentity(page), null);
    assert.equal(verifyPageProof(key, "session", "/tmp/root", page, proof, file), true);
    assert.equal(verifyPageProof(key, "session", "/tmp/root", page, proof), false);
    assert.equal(verifyPageProof(key, "other", "/tmp/root", page, proof, file), false);
    assert.equal(verifyPageProof(key, "session", "/tmp/other", page, proof, file), false);
    assert.equal(verifyPageProof(key, "session", "/tmp/root", "report/final.html", proof, file), false);
    assert.equal(verifyPageProof(key, "session", "/tmp/root", page, proof, "/tmp/root/other.html"), false);
    assert.throws(() => signPageProof(key, "session", "/tmp/root", "sibling\\page.html", file));
  },
);
// An independent reading of the key's security descriptor. It is handed its target through the
// environment and uses no module cmdlets: a Windows PowerShell child of a PowerShell 7 step
// inherits a PSModulePath whose modules it cannot load, and text after -Command is parsed as code.
const WINDOWS_ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner
$acl = [System.Security.AccessControl.FileSecurity]::new($env:LAVISH_AXI_TEST_ACL_TARGET, $sections)
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$foreignAllowCount = 0
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $rule.IdentityReference.Value -ne $currentUserSid) {
    $foreignAllowCount += 1
  }
}
[Console]::Out.Write(
  [string]::Join('|', @([string]$acl.AreAccessRulesProtected, $currentUserSid, $ownerSid, [string]$foreignAllowCount))
)
`;

async function inspectWindowsAcl(file) {
  const inspection = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_INSPECTION_SCRIPT],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: { ...process.env, LAVISH_AXI_TEST_ACL_TARGET: file },
    },
  );
  const [inheritanceProtected, currentUserSid, ownerSid, foreignAllowCount] = String(inspection.stdout || "")
    .trim()
    .split("|");
  return {
    inheritanceProtected: inheritanceProtected === "True",
    currentUserSid,
    ownerSid,
    foreignAllowCount: Number(foreignAllowCount),
  };
}

test("page proofs bind the session, canonical root, and normalized page", () => {
  const key = Buffer.alloc(32, 7);
  const proof = signPageProof(key, "session-1", "/tmp/root", "sub/./page.html");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(proof.at(-1));
  const nonCanonicalAlias = proof.slice(0, -1) + alphabet[finalIndex + 1];

  assert.equal(typeof proof, "string");
  assert.notEqual(nonCanonicalAlias, proof);
  assert.deepEqual(Buffer.from(nonCanonicalAlias, "base64url"), Buffer.from(proof, "base64url"));
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", proof), true);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", nonCanonicalAlias), false);
  assert.equal(verifyPageProof(key, "session-2", "/tmp/root", "sub/page.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/other", "sub/page.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "other.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", `!${proof}`), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", `${proof}!`), false);
  assert.equal(normalizePageIdentity("./sub/../page.html"), "page.html");
  assert.equal(normalizePageIdentity("../outside.html"), null);
  assert.equal(normalizePageIdentity("C:\\outside.html"), null);
});

test(
  "production POSIX page proof key creation is durable, owner-only, and atomic",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-"));
    try {
      const keys = await Promise.all(Array.from({ length: 16 }, () => loadPageProofKey(root)));
      const first = await readFile(path.join(root, "page-proof.key"));
      assert.equal(first.length, 32);
      for (const key of keys) assert.deepEqual(key, first);
      assert.equal((await stat(path.join(root, "page-proof.key"))).mode & 0o777, 0o600);
      assert.equal(await loadPageProofKey(root).then((key) => key.equals(first)), true);
      assert.deepEqual(await readdir(root), ["page-proof.key"]);
      assert.equal(await stat(path.join(root, "state.json")).catch(() => null), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "production Windows page proof key creation is owner-only and atomic",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-production-"));
    try {
      const keys = await Promise.all(Array.from({ length: 16 }, () => loadPageProofKey(root)));
      const keyFile = path.join(root, "page-proof.key");
      const first = await readFile(keyFile);
      assert.equal(first.length, 32);
      for (const key of keys) assert.deepEqual(key, first);
      assert.deepEqual(await loadPageProofKey(root), first);
      assert.deepEqual(await readdir(root), ["page-proof.key"]);
      const acl = await inspectWindowsAcl(keyFile);
      assert.equal(acl.inheritanceProtected, true);
      assert.match(acl.currentUserSid, /^S-\d(?:-\d+)+$/);
      assert.equal(acl.ownerSid, acl.currentUserSid);
      assert.equal(acl.foreignAllowCount, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "production Windows verification rejects a key that inherits its directory's ACL",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-inherited-"));
    const keyFile = path.join(root, "page-proof.key");
    try {
      await writeFile(keyFile, Buffer.alloc(32, 5));
      assert.equal((await inspectWindowsAcl(keyFile)).inheritanceProtected, false);
      await assert.rejects(
        loadPageProofKey(root),
        /page-proof\.key.*ACL is not owner-only.*invalidates existing queued page proofs/is,
      );
      assert.deepEqual(await readFile(keyFile), Buffer.alloc(32, 5));
      assert.deepEqual(await readdir(root), ["page-proof.key"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "production Windows key paths reach the ACL helper as data, never as script text",
  { skip: process.platform !== "win32" },
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-path-"));
    const root = path.join(parent, "it's a $(throw 'parsed') dir; exit 7 #");
    try {
      await mkdir(root);
      const key = await loadPageProofKey(root);
      assert.equal(key.length, 32);
      assert.deepEqual(await loadPageProofKey(root), key);
      assert.deepEqual(await readdir(root), ["page-proof.key"]);
      const acl = await inspectWindowsAcl(path.join(root, "page-proof.key"));
      assert.equal(acl.inheritanceProtected, true);
      assert.equal(acl.ownerSid, acl.currentUserSid);
      assert.equal(acl.foreignAllowCount, 0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "the ACL helper receives its operation and refuses one it does not implement",
  { skip: !ACL_SHELL_AVAILABLE && `${ACL_SHELL} is not installed` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-acl-operation-"));
    const keyFile = path.join(root, "page-proof.key");
    try {
      await writeFile(keyFile, Buffer.alloc(32, 3), { mode: 0o600 });
      // An operation that never arrives must not read as a verification that passed, and an
      // unknown one must not fall through to either branch.
      await assert.rejects(
        windowsPageProofAcl(keyFile, "rotate", { shell: ACL_SHELL }),
        /unsupported page-proof ACL operation 'rotate'/,
      );
      await assert.rejects(
        windowsPageProofAcl(keyFile, "", { shell: ACL_SHELL }),
        /unsupported page-proof ACL operation ''/,
      );
      assert.deepEqual(await readFile(keyFile), Buffer.alloc(32, 3));
      assert.deepEqual(await readdir(root), ["page-proof.key"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an existing corrupt page proof key fails without silent rotation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-corrupt-"));
  const keyFile = path.join(root, "page-proof.key");
  try {
    // Start from a production key so the length check is reached on Windows too, where a plainly
    // written file is refused for its inherited ACL first.
    await loadPageProofKey(root);
    await truncate(keyFile, 31);
    await assert.rejects(
      loadPageProofKey(root),
      /page-proof\.key.*exactly 32 bytes.*invalidates existing queued page proofs/i,
    );
    assert.equal((await readFile(keyFile)).length, 31);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows page proof keys are restricted and verified through ACLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-"));
  const calls = [];
  const windowsAcl = async (file, operation) => {
    calls.push({ file, operation });
    if (operation === "create") {
      assert.equal(await stat(file).catch(() => null), null);
      await writeFile(file, Buffer.alloc(32, 11), { flag: "wx" });
    }
  };
  try {
    const key = await loadPageProofKey(root, { platform: "win32", windowsAcl });
    assert.equal(key.length, 32);
    assert.equal(calls[0].operation, "create");
    assert.match(path.basename(calls[0].file), /^\.page-proof\.key\..+\.tmp$/);
    assert.deepEqual(calls[1], { file: calls[0].file, operation: "verify" });
    assert.deepEqual(calls.at(-1), { file: path.join(root, "page-proof.key"), operation: "verify" });

    calls.length = 0;
    assert.deepEqual(await loadPageProofKey(root, { platform: "win32", windowsAcl }), key);
    assert.deepEqual(calls, [{ file: path.join(root, "page-proof.key"), operation: "verify" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows removes an incomplete atomic key creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-failed-create-"));
  try {
    await assert.rejects(
      loadPageProofKey(root, {
        platform: "win32",
        windowsAcl: async (file, operation) => {
          if (operation !== "create") return;
          await writeFile(file, Buffer.alloc(1), { flag: "wx" });
          throw new Error("atomic creation failed");
        },
      }),
      /page-proof\.key.*atomic creation failed.*invalidates existing queued page proofs/i,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows rejects a page proof key whose ACL is not owner-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-open-"));
  const keyFile = path.join(root, "page-proof.key");
  try {
    await writeFile(keyFile, Buffer.alloc(32, 9));
    await assert.rejects(
      loadPageProofKey(root, {
        platform: "win32",
        windowsAcl: async () => {
          throw new Error("the file ACL is not owner-only");
        },
      }),
      /page-proof\.key.*ACL is not owner-only.*invalidates existing queued page proofs/i,
    );
    assert.deepEqual(await readFile(keyFile), Buffer.alloc(32, 9));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
