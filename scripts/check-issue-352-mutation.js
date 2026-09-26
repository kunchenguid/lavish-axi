import crypto from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..");
const B01_PATTERN = "^352-B01(?:/|$)";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function run(command, args, cwd, env, timeout = 180_000) {
  const childEnv = { ...process.env, ...env };
  // The mutation test deliberately launches the exact B01 runner as a child.
  // Do not let Node's parent-test recursion marker turn that child into a skip.
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

async function copyCheckout(sourceRoot, targetRoot) {
  for (const name of ["package.json", "pnpm-lock.yaml", "bin", "scripts", "src", "test"]) {
    await cp(path.join(sourceRoot, name), path.join(targetRoot, name), { recursive: true });
  }
  await symlink(path.join(sourceRoot, "node_modules"), path.join(targetRoot, "node_modules"), "dir");
}

function build(copyRoot) {
  return run(process.execPath, ["scripts/build.js"], copyRoot, {}, 180_000);
}

function b01(copyRoot) {
  return run(
    process.execPath,
    ["--test", `--test-name-pattern=${B01_PATTERN}`, "test/issue-352-review.browser.test.js"],
    copyRoot,
    { LAVISH_AXI_BROWSER_E2E: "1" },
    180_000,
  );
}

function isGreen(result) {
  return result.status === 0 && /# pass 11\b/.test(result.output) && /ok 1 - 352-B01/.test(result.output);
}

function mutateSiblingInjection(source) {
  const seam = "    if (documentEligible) {";
  const mutant = "    if (documentEligible && pageResolution?.page === entryName) {";
  if (source.split(seam).length !== 2 || source.includes(mutant)) {
    throw new Error("M01 could not identify one unique sibling document injection seam");
  }
  // Keep the entry document on the normal injection path while making eligible
  // sibling HTML fall through to the raw asset route. This disconnects the real
  // product seam without depending on Prettier's wrapping of injectLavishSdk.
  return source.replace(seam, mutant);
}

export async function runIssue352Mutation({ repoRoot = defaultRepoRoot } = {}) {
  const sourceServer = path.join(repoRoot, "src", "server.js");
  const originalWorkingBytes = await readFile(sourceServer);
  const originalWorkingHash = sha256(originalWorkingBytes);
  const copyRoot = await mkdtemp(path.join(os.tmpdir(), "lavish-352-m01-"));
  const result = {
    copyRoot,
    outsideRepo: !path.resolve(copyRoot).startsWith(`${path.resolve(repoRoot)}${path.sep}`),
    originalGreen: false,
    siblingReviewUnavailable: false,
    intendedAssertionRed: false,
    restoredGreen: false,
    cleanup: false,
    workingTreeUnchanged: false,
    diagnostics: {},
  };

  try {
    await copyCheckout(repoRoot, copyRoot);
    const copiedServer = path.join(copyRoot, "src", "server.js");
    const baselineSource = await readFile(copiedServer, "utf8");

    const baselineBuild = build(copyRoot);
    if (baselineBuild.status !== 0) {
      throw new Error(`M01 baseline build failed\n${baselineBuild.output}`);
    }
    const original = b01(copyRoot);
    result.diagnostics.original = original.output;
    result.originalGreen = isGreen(original);
    if (!result.originalGreen) throw new Error(`M01 baseline B01 was not green\n${original.output}`);

    const mutantSource = mutateSiblingInjection(baselineSource);
    await writeFile(copiedServer, mutantSource, "utf8");
    const mutantBuild = build(copyRoot);
    if (mutantBuild.status !== 0) {
      throw new Error(`M01 mutant build failed instead of reaching the product assertion\n${mutantBuild.output}`);
    }
    const mutant = b01(copyRoot);
    result.diagnostics.mutant = mutant.output;
    result.siblingReviewUnavailable =
      /authored sibling did not become reviewable/.test(mutant.output) ||
      /sibling annotation card did not open/.test(mutant.output);
    result.intendedAssertionRed =
      mutant.status !== 0 &&
      result.siblingReviewUnavailable &&
      !/failed instead of reaching the product assertion/i.test(mutant.output);
    if (!result.intendedAssertionRed) {
      throw new Error(`M01 mutant did not fail at the sibling review seam\n${mutant.output}`);
    }

    await writeFile(copiedServer, baselineSource, "utf8");
    const restoredBuild = build(copyRoot);
    if (restoredBuild.status !== 0) {
      throw new Error(`M01 restored build failed\n${restoredBuild.output}`);
    }
    const restored = b01(copyRoot);
    result.diagnostics.restored = restored.output;
    result.restoredGreen = isGreen(restored);
    if (!result.restoredGreen) throw new Error(`M01 restored B01 was not green\n${restored.output}`);
  } finally {
    await rm(copyRoot, { recursive: true, force: true });
    result.cleanup = (await lstat(copyRoot).catch(() => null)) === null;
    result.workingTreeUnchanged = sha256(await readFile(sourceServer)) === originalWorkingHash;
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.env.ISSUE_352_ACCEPTANCE !== "1") {
    process.stderr.write("ISSUE_352_ACCEPTANCE=1 is required for the destructive-control run\n");
    process.exitCode = 2;
  } else {
    runIssue352Mutation()
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
