import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule in firstmate's release-please CI
 * report: node -> package.json (+ package-lock.json if present), changelog,
 * extra-files, and the manifest path.
 */
function expectedReleaseOutputs() {
  const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog = pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(pkg["version-file"] ?? config["version-file"] ?? "version.txt");
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(`unsupported release-please release-type for ignore derivation: ${releaseType}`);
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(join(workflowsDir, "release-please.yml"), "utf8");
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

/**
 * Minimal workflow `on` extractor. Avoids a YAML dependency: these workflows
 * only use the simple mapping/list shape GitHub Actions documents, and the
 * fleet drift check only needs pull_request path filters plus sibling triggers.
 */
function loadWorkflowOn(filePath) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^(on|true):\s*$/.test(lines[i])) i += 1;
  if (i >= lines.length) return null;
  i += 1;

  const on = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith("#") || line.startsWith(" ")) {
      // still inside on-block whitespace/comments; fall through
    } else if (!line.startsWith(" ") && line.endsWith(":")) {
      // next top-level key
      break;
    } else if (!line.startsWith(" ")) {
      break;
    }

    const eventMatch = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!eventMatch) {
      i += 1;
      continue;
    }

    const eventName = eventMatch[1];
    const inline = eventMatch[2].trim();
    i += 1;

    if (inline && inline !== "|" && inline !== ">") {
      on[eventName] = inline.replace(/^["']|["']$/g, "");
      continue;
    }

    const event = {};
    while (i < lines.length) {
      const body = lines[i];
      if (/^ {2}[A-Za-z_]/.test(body) || (/^[^ #\t]/.test(body) && body.trim() !== "")) {
        break;
      }
      if (body.trim() === "" || body.trimStart().startsWith("#")) {
        i += 1;
        continue;
      }

      const keyMatch = body.match(/^ {4}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!keyMatch) {
        i += 1;
        continue;
      }

      const key = keyMatch[1];
      const rest = keyMatch[2].trim();
      i += 1;

      if (rest.startsWith("[") && rest.endsWith("]")) {
        event[key] = rest
          .slice(1, -1)
          .split(",")
          .map((part) => part.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        continue;
      }

      if (rest !== "" && rest !== "|" && rest !== ">") {
        event[key] = rest.replace(/^["']|["']$/g, "");
        continue;
      }

      const values = [];
      while (i < lines.length) {
        const item = lines[i];
        const listMatch = item.match(/^ {6}-\s+(.+)$/);
        if (!listMatch) break;
        values.push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
        i += 1;
      }
      event[key] = values;
    }

    on[eventName] = event;
  }

  return on;
}

function pullRequestFilterCoverage(pr) {
  if (pr == null) return { kind: "unfiltered" };
  if (typeof pr !== "object" || Array.isArray(pr)) return { kind: "unfiltered" };

  if (Array.isArray(pr["paths-ignore"])) {
    return { kind: "paths-ignore", paths: pr["paths-ignore"].map(String) };
  }
  if (Array.isArray(pr.paths)) {
    return { kind: "paths", paths: pr.paths.map(String) };
  }
  return { kind: "unfiltered" };
}

function globMatch(pattern, path) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isCovered(filter, releasePath) {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (matched && (negated === releasePath || globMatch(negated, releasePath))) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  return !matched;
}

const expected = expectedReleaseOutputs();

test("derives the node release-output set for this repository", () => {
  // plugin.json is an extra-file: release-please bumps its version alongside package.json.
  assert.deepEqual(expected, ["CHANGELOG.md", "package.json", "plugin.json", ".release-please-manifest.json"]);
});

test("every pull_request workflow ignores the full release-output set", () => {
  const files = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"));
  const prWorkflows = [];

  for (const name of files) {
    const filePath = join(workflowsDir, name);
    const on = loadWorkflowOn(filePath);
    if (!on || !("pull_request" in on)) continue;
    prWorkflows.push({ name, filter: pullRequestFilterCoverage(on.pull_request) });
  }

  assert.deepEqual(prWorkflows.map((w) => w.name).sort(), [
    "ci.yml",
    "guard-generated-files.yml",
    "no-mistakes-required.yml",
  ]);

  const failures = [];
  for (const { name, filter } of prWorkflows) {
    const missing = expected.filter((path) => !isCovered(filter, path));
    if (missing.length > 0) {
      failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
    }
  }

  assert.deepEqual(failures, []);
});

test("does not attach path filters to non-pull_request triggers on ci.yml", () => {
  const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
  assert.ok(on);
  assert.deepEqual(on.push, { branches: ["main"] });
  assert.deepEqual(on.pull_request.branches, ["main"]);
  assert.deepEqual(on.pull_request["paths-ignore"], [
    ".release-please-manifest.json",
    "CHANGELOG.md",
    "package.json",
    "plugin.json",
  ]);
  assert.equal(on.release, undefined);
  assert.equal(on.workflow_dispatch, undefined);
});

test("keeps bot author exemptions on guard and no-mistakes jobs", () => {
  const guard = readFileSync(join(workflowsDir, "guard-generated-files.yml"), "utf8");
  const nmr = readFileSync(join(workflowsDir, "no-mistakes-required.yml"), "utf8");
  assert.match(guard, /github-actions\[bot\]/);
  assert.match(guard, /release-please\[bot\]/);
  assert.match(nmr, /github-actions\[bot\]/);
  assert.match(nmr, /dependabot\[bot\]/);
  assert.match(nmr, /release-please\[bot\]/);
});
