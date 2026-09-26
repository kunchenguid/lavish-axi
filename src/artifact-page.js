import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, unlink, writeFile, link, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { sameFileIdentity } from "./verified-local-file.js";

const PAGE_PROOF_DOMAIN = "page-v1";
const PAGE_PROOF_KEY_BYTES = 32;
const PAGE_PROOF_MAC_BYTES = 32;
const PAGE_PROOF_MAX_PAGE_BYTES = 16 * 1024;
const execFileAsync = promisify(execFile);
const artifactPageIdentities = new WeakMap();
const pageProofKeyIdentities = new WeakMap();
const WINDOWS_PAGE_PROOF_ACL_OPERATION_ENV = "LAVISH_AXI_PAGE_PROOF_ACL_OPERATION";
const WINDOWS_PAGE_PROOF_ACL_TARGET_ENV = "LAVISH_AXI_PAGE_PROOF_ACL_TARGET";
// Two properties of how this script is started are load-bearing:
// - Its inputs arrive through the environment. PowerShell appends every argument after -Command
//   to the command text instead of binding $args, so an operation passed there never arrived
//   (create fell through to verify) and the key path was parsed as script.
// - It uses only language constructs and .NET types, never a module cmdlet. When an ancestor
//   process is PowerShell 7 (a GitHub Actions step, a pwsh terminal), Windows PowerShell inherits
//   a PSModulePath naming PowerShell 7 modules it cannot load, so Get-Acl and even Write-Output
//   fail to autoload.
// An operation that is neither create nor verify is refused, so nothing can fall through to a
// branch it did not ask for.
const WINDOWS_PAGE_PROOF_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$operation = [string]$env:${WINDOWS_PAGE_PROOF_ACL_OPERATION_ENV}
$target = [string]$env:${WINDOWS_PAGE_PROOF_ACL_TARGET_ENV}
if ($operation -cne 'create' -and $operation -cne 'verify') {
  throw "unsupported page-proof ACL operation '$operation'"
}
if ($target.Length -eq 0) {
  throw 'the page-proof ACL target is missing'
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($operation -ceq 'create') {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  [void]$security.AddAccessRule($rule)
  $stream = [System.IO.FileStream]::new(
    $target,
    [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.IO.FileShare]::None,
    4096,
    [System.IO.FileOptions]::WriteThrough,
    $security
  )
  try {
    $bytes = [byte[]]::new(${PAGE_PROOF_KEY_BYTES})
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  exit 0
}
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor
  [System.Security.AccessControl.AccessControlSections]::Owner
$acl = [System.Security.AccessControl.FileSecurity]::new($target, $sections)
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$foreignAllows = 0
$ownerAllows = 0
foreach ($entry in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if ($entry.IdentityReference.Value -eq $sid.Value) { $ownerAllows += 1 } else { $foreignAllows += 1 }
}
if (-not $acl.AreAccessRulesProtected -or $null -eq $ownerSid -or $ownerSid.Value -ne $sid.Value -or
    $foreignAllows -ne 0 -or $ownerAllows -eq 0) {
  throw 'the file ACL is not owner-only'
}
[Console]::Out.Write('PAGE_PROOF_ACL_OK')
`;

export function pageProofKeyPath(stateDir) {
  return path.join(path.resolve(String(stateDir)), "page-proof.key");
}

export function pageProofKeyIdentity(key) {
  return pageProofKeyIdentities.get(key) || null;
}

/**
 * A document reached through authored navigation is eligible for review only when it is a local
 * HTML document. The saved entry is handled separately because an entry may be extensionless
 * (or a symlink to an extensionless file) while CLI validation has already established it as the
 * session's review target.
 */
export function isArtifactHtmlPage(assetPath) {
  return typeof assetPath === "string" && /\.html?$/i.test(assetPath);
}

function asRootRelative(root, file) {
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Normalize an already URL-decoded root-relative page identity. */
export function normalizePageIdentity(page) {
  if (typeof page !== "string" || page.length === 0 || Buffer.byteLength(page, "utf8") > PAGE_PROOF_MAX_PAGE_BYTES) {
    return null;
  }
  if (page.includes("\0") || page.includes("\\") || page.startsWith("/") || /^[A-Za-z]:[\\/]/.test(page)) {
    return null;
  }
  const parts = page.split("/");
  const normalized = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    if (part.includes("\0") || part.includes("\\")) return null;
    normalized.push(part);
  }
  if (normalized.length === 0) return null;
  return normalized.join("/");
}

function rootDigest(canonicalRoot) {
  return crypto.createHash("sha256").update(String(canonicalRoot), "utf8").digest("hex");
}

// Only the server's canonical saved entry may use a literal POSIX backslash.
// This is not a sibling-path normalizer; callers must supply the saved file,
// never an identity taken from a request.
export function normalizeReviewPageIdentity(page, entryFile = "") {
  if (
    path.sep === "/" &&
    entryFile &&
    page === path.basename(entryFile) &&
    typeof page === "string" &&
    page.includes("\\") &&
    !page.includes("\0") &&
    Buffer.byteLength(page, "utf8") <= PAGE_PROOF_MAX_PAGE_BYTES
  )
    return page;
  return normalizePageIdentity(page);
}

function proofPayload(sessionKey, canonicalRoot, page, entryFile) {
  const normalizedPage = normalizeReviewPageIdentity(page, entryFile);
  if (!normalizedPage) return null;
  const domain = normalizedPage.includes("\\") ? "saved-entry-v1" : PAGE_PROOF_DOMAIN;
  return JSON.stringify([domain, String(sessionKey), rootDigest(canonicalRoot), normalizedPage]);
}

function decodeProof(proof) {
  // A SHA-256 MAC has one canonical unpadded base64url representation: 43
  // characters. Reject permissive decoder aliases/trailing junk before decode.
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return null;
  try {
    const decoded = Buffer.from(proof, "base64url");
    if (decoded.length !== PAGE_PROOF_MAC_BYTES) return null;
    // Node's decoder accepts alternate final characters whose unused low bits differ but decode
    // to the same 32 bytes. Proofs are protocol credentials, so accept only the one canonical
    // spelling emitted by signPageProof instead of letting textual tampering survive decoding.
    if (decoded.toString("base64url") !== proof) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Create the fixed-size HMAC proof for an authoritative page identity. */
export function signPageProof(key, sessionKey, canonicalRoot, page, entryFile = "") {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) {
    throw new TypeError("page proof key must be exactly 32 bytes");
  }
  const payload = proofPayload(sessionKey, canonicalRoot, page, entryFile);
  if (!payload) throw new TypeError("invalid page identity");
  return crypto.createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** Verify a proof without touching the filesystem. Source reads still require fresh resolution. */
export function verifyPageProof(key, sessionKey, canonicalRoot, page, proof, entryFile = "") {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) return false;
  const expectedPayload = proofPayload(sessionKey, canonicalRoot, page, entryFile);
  const actual = decodeProof(proof);
  if (!expectedPayload || !actual) return false;
  const expected = crypto.createHmac("sha256", key).update(expectedPayload, "utf8").digest();
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export { PAGE_PROOF_DOMAIN, PAGE_PROOF_KEY_BYTES, PAGE_PROOF_MAX_PAGE_BYTES };

// Chrome authentication for the protocol-1 handshake. Each served document carries a fresh
// server-minted nonce and this MAC over it. Only a same-origin chrome holding the current
// artifact generation can obtain the MAC for a nonce. That chrome may relay a genuine MAC to
// whatever page occupies its frame, so the SDK also requires the challenge to come from its own
// server origin; together they tell a document its parent is this server's chrome before it
// reveals a load token or page proof. The MAC is domain-separated from page proofs and grants
// nothing by itself.
const CHROME_AUTH_NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;

export function isChromeAuthNonce(nonce) {
  return typeof nonce === "string" && CHROME_AUTH_NONCE_RE.test(nonce);
}

export function createChromeAuthNonce() {
  return crypto.randomBytes(24).toString("base64url");
}

export function signChromeAuth(key, sessionKey, nonce) {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) {
    throw new TypeError("page proof key must be exactly 32 bytes");
  }
  if (typeof sessionKey !== "string" || !sessionKey || !isChromeAuthNonce(nonce)) {
    throw new TypeError("invalid chrome auth input");
  }
  return crypto
    .createHmac("sha256", key)
    .update(JSON.stringify(["chrome-auth-v1", sessionKey, nonce]), "utf8")
    .digest("base64url");
}

export function verifyChromeAuth(key, sessionKey, nonce, auth) {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) return false;
  if (typeof sessionKey !== "string" || !sessionKey || !isChromeAuthNonce(nonce) || typeof auth !== "string") {
    return false;
  }
  const expected = Buffer.from(signChromeAuth(key, sessionKey, nonce));
  const actual = Buffer.from(auth);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Historical evidence only. Callers must validate the complete destination before signing,
// and resolve it afresh after verification. Keep this MAC separate from page authorization.
function historicalDestinationPayload(sessionKey, canonicalRoot, entryFile, destination, documentId) {
  if (typeof documentId !== "string" || !documentId || documentId.length > 256) return null;
  const fields = [destination?.page, destination?.route, destination?.url];
  if (fields.some((value) => typeof value !== "string" || !value || Buffer.byteLength(value) > 64 * 1024)) return null;
  return JSON.stringify([
    "historical-destination-v1",
    sessionKey,
    rootDigest(canonicalRoot),
    entryFile,
    ...fields,
    documentId,
  ]);
}

export function signHistoricalDestination(key, sessionKey, canonicalRoot, entryFile, destination, documentId) {
  const payload = historicalDestinationPayload(sessionKey, canonicalRoot, entryFile, destination, documentId);
  if (!payload || !Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) return null;
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function verifyHistoricalDestination(
  key,
  sessionKey,
  canonicalRoot,
  entryFile,
  destination,
  documentId,
  receipt,
) {
  const expected = signHistoricalDestination(key, sessionKey, canonicalRoot, entryFile, destination, documentId);
  const actual = decodeProof(receipt);
  return Boolean(expected && actual && crypto.timingSafeEqual(Buffer.from(expected, "base64url"), actual));
}

function pageProofKeyError(file, detail) {
  return new Error(
    `Unable to use page-proof key ${file}: ${detail}. Restore the original key; regenerating it invalidates existing queued page proofs.`,
  );
}

/**
 * Create (`create`) or prove (`verify`) the owner-only protected ACL of a Windows key file.
 * `shell` exists so the script's dispatch can be executed where Windows PowerShell is absent.
 */
export async function windowsPageProofAcl(file, operation, { shell = "powershell.exe" } = {}) {
  const result = await execFileAsync(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PAGE_PROOF_ACL_SCRIPT],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        [WINDOWS_PAGE_PROOF_ACL_OPERATION_ENV]: String(operation),
        [WINDOWS_PAGE_PROOF_ACL_TARGET_ENV]: String(file),
      },
    },
  );
  if (operation === "verify" && String(result.stdout || "").trim() !== "PAGE_PROOF_ACL_OK") {
    throw new Error("the file ACL could not be verified as owner-only");
  }
}

async function readExistingPageProofKey(file, { platform, windowsAcl }) {
  let details;
  try {
    details = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw pageProofKeyError(file, error?.message || String(error));
  }
  if (!details.isFile()) throw pageProofKeyError(file, "the path is not a regular file");
  if (platform === "win32") {
    try {
      await windowsAcl(file, "verify");
    } catch (error) {
      throw pageProofKeyError(file, error?.message || String(error));
    }
  } else if ((details.mode & 0o077n) !== 0n) {
    throw pageProofKeyError(file, "the file is not owner-only (expected mode 0600)");
  }
  let handle;
  let value;
  try {
    handle = await open(file, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(details, opened)) {
      throw new Error("the file changed while it was opened");
    }
    value = await handle.readFile();
    pageProofKeyIdentities.set(value, { dev: opened.dev, ino: opened.ino });
  } catch (error) {
    throw pageProofKeyError(file, error?.message || String(error));
  } finally {
    await handle?.close();
  }
  if (value.length !== PAGE_PROOF_KEY_BYTES) {
    throw pageProofKeyError(file, `the file must contain exactly ${PAGE_PROOF_KEY_BYTES} bytes`);
  }
  return value;
}

/**
 * Load the durable proof key, creating it exactly once on first use. The temporary file is fully
 * written before a hard-link installs it at the final name; this avoids a concurrent server ever
 * observing a partially-written key. Losing creators read the winning file instead.
 */
export async function loadPageProofKey(
  stateDir,
  { platform = process.platform, windowsAcl = windowsPageProofAcl } = {},
) {
  const directory = path.resolve(String(stateDir));
  const file = pageProofKeyPath(directory);
  await mkdir(directory, { recursive: true });
  const existing = await readExistingPageProofKey(file, { platform, windowsAcl });
  if (existing) return existing;

  const temporary = path.join(directory, `.page-proof.key.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    if (platform === "win32") {
      try {
        await windowsAcl(temporary, "create");
        await windowsAcl(temporary, "verify");
      } catch (error) {
        throw pageProofKeyError(file, error?.message || String(error));
      }
      const created = await readFile(temporary);
      if (created.length !== PAGE_PROOF_KEY_BYTES) {
        throw pageProofKeyError(file, `the new key must contain exactly ${PAGE_PROOF_KEY_BYTES} bytes`);
      }
    } else {
      await writeFile(temporary, crypto.randomBytes(PAGE_PROOF_KEY_BYTES), { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw pageProofKeyError(file, error?.message || String(error));
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const winner = await readExistingPageProofKey(file, { platform, windowsAcl });
  if (!winner) throw pageProofKeyError(file, "the key disappeared during initialization");
  return winner;
}

/**
 * Resolve an authored HTML page to its canonical in-root regular file. Internal symlink aliases
 * are accepted and share the canonical target identity; any lexical or realpath escape is
 * classified as forbidden. Missing path components remain distinguishable from an escape.
 *
 * @param {string} root
 * @param {string} assetPath URL-decoded, root-relative route path
 * @param {{ entryFile?: string, statFile?: typeof stat }} [options]
 * @returns {Promise<{file: string | null, reason: "ok" | "missing" | "forbidden", page: string | null, servedRoute: string | null}>}
 */
export async function resolveArtifactPage(root, assetPath, { entryFile = "", statFile = stat } = {}) {
  const result = (file, reason, page = null, servedRoute = null) => ({ file, reason, page, servedRoute });
  const isEntry = typeof entryFile === "string" && entryFile !== "" && assetPath === entryFile;
  if (
    isEntry &&
    path.sep === "/" &&
    assetPath.includes("\\") &&
    !assetPath.includes("/") &&
    !assetPath.includes("\0")
  ) {
    const entry = await resolveArtifactEntry(path.join(root, entryFile), { statFile });
    if (entry.reason === "ok") {
      entry.page = entryFile;
      entry.servedRoute = entryFile;
    }
    return entry;
  }
  if ((!isArtifactHtmlPage(assetPath) && !isEntry) || assetPath.includes("\0") || assetPath.includes("\\")) {
    return result(null, "forbidden");
  }
  if (path.isAbsolute(assetPath)) return result(null, "forbidden");

  const lexicalRoot = path.resolve(root);
  const lexicalFile = path.resolve(lexicalRoot, assetPath);
  const lexicalRelative = path.relative(lexicalRoot, lexicalFile);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    return result(null, "forbidden");
  }

  let realRoot;
  let realFile;
  try {
    [realRoot, realFile] = await Promise.all([realpath(lexicalRoot), realpath(lexicalFile)]);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }

  const page = asRootRelative(realRoot, realFile);
  if (!page) return result(null, "forbidden");
  if (!normalizePageIdentity(page)) return result(null, "forbidden");
  // Eligibility follows the canonical target, not merely an HTML-looking
  // symlink name. The saved entry is the sole extensionless exception because
  // CLI validation already established that exact route as the review target.
  if (!isEntry && !isArtifactHtmlPage(page)) return result(null, "forbidden");
  let details;
  try {
    details = await statFile(realFile, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }
  if (!details.isFile()) return result(null, "forbidden");
  let verifiedRealFile;
  try {
    verifiedRealFile = await realpath(realFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }
  if (verifiedRealFile !== realFile || !asRootRelative(realRoot, verifiedRealFile)) {
    return result(null, "forbidden");
  }
  const resolved = result(realFile, "ok", page, assetPath.split(path.sep).join("/"));
  artifactPageIdentities.set(resolved, { dev: details.dev, ino: details.ino });
  return resolved;
}

export async function resolveArtifactEntry(file, { statFile = stat } = {}) {
  const result = (resolvedFile, reason) => ({ file: resolvedFile, reason, page: null, servedRoute: null });
  const absolute = path.resolve(file);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (canonical !== absolute) return result(null, "forbidden");
  let details;
  try {
    details = await statFile(canonical, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (!details.isFile()) return result(null, "forbidden");
  let verified;
  try {
    verified = await realpath(canonical);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (verified !== canonical) return result(null, "forbidden");
  const resolved = result(canonical, "ok");
  artifactPageIdentities.set(resolved, { dev: details.dev, ino: details.ino });
  return resolved;
}

/**
 * @param {{ file: string | null, reason: string }} resolution
 * @param {{ openFile?: typeof open, forbiddenFileIdentities?: Array<{dev: bigint, ino: bigint}> }} [options]
 */
export async function readResolvedArtifactPage(resolution, { openFile = open, forbiddenFileIdentities = [] } = {}) {
  const expected = artifactPageIdentities.get(resolution);
  if (!expected || resolution?.reason !== "ok" || !resolution.file) {
    throw Object.assign(new Error("artifact page resolution is not readable"), {
      code: "ARTIFACT_PAGE_CHANGED",
      status: 403,
    });
  }
  const handle = await openFile(resolution.file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw Object.assign(new Error("artifact page changed after resolution"), {
        code: "ARTIFACT_PAGE_CHANGED",
        status: 403,
      });
    }
    if (forbiddenFileIdentities.some((identity) => sameFileIdentity(opened, identity))) {
      throw Object.assign(new Error("refusing to read protected local file"), {
        code: "ARTIFACT_PAGE_CHANGED",
        status: 403,
      });
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function canonicalArtifactRoot(root) {
  return realpath(path.resolve(root));
}

/**
 * Compare one decoded identity per path segment, preserving authored URL spelling.
 * The expected path must encode an independently authorized lexical served route:
 * this does not authorize aliases or backslashes (only the saved POSIX entry can).
 * Keep the standalone chrome-client.js counterpart in sync.
 * @param {string} pathname
 * @param {string} expectedPath
 */
export function artifactDestinationPathMatches(pathname, expectedPath) {
  try {
    const actual = pathname.split("/");
    const expected = expectedPath.split("/");
    return (
      actual.length === expected.length &&
      actual.every((part, index) => {
        const decoded = decodeURIComponent(part);
        return (
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("\0") &&
          !decoded.includes("/") &&
          decoded === decodeURIComponent(expected[index])
        );
      })
    );
  } catch {
    return false;
  }
}
