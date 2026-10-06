import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_HTML_ERROR,
  artifactTreeRoot,
  hasHiddenPathSegment,
  isHtmlPath,
  resolveAllowedArtifactFile,
} from "../src/artifact-path.js";

test("isHtmlPath matches the CLI .html / .htm rule", () => {
  assert.equal(isHtmlPath("report.html"), true);
  assert.equal(isHtmlPath("report.HTML"), true);
  assert.equal(isHtmlPath("report.htm"), true);
  assert.equal(isHtmlPath("/tmp/preview.Htm"), true);
  assert.equal(isHtmlPath("report.txt"), false);
  assert.equal(isHtmlPath("report.html.bak"), false);
  assert.equal(isHtmlPath("/etc/passwd"), false);
  assert.equal(isHtmlPath(""), false);
});

test("hasHiddenPathSegment is about the request-relative path, not a dotted root", () => {
  assert.equal(hasHiddenPathSegment("style.css"), false);
  assert.equal(hasHiddenPathSegment("assets/icon.svg"), false);
  assert.equal(hasHiddenPathSegment("pages/about.html"), false);
  assert.equal(hasHiddenPathSegment(".env"), true);
  assert.equal(hasHiddenPathSegment(".git/config"), true);
  assert.equal(hasHiddenPathSegment("assets/.secret"), true);
  assert.equal(hasHiddenPathSegment("vendor/.git/HEAD"), true);
});

test("artifactTreeRoot is the HTML file's directory", () => {
  assert.equal(artifactTreeRoot("/tmp/preview/index.html"), "/tmp/preview");
});

test("resolveAllowedArtifactFile accepts a regular HTML file and returns its real path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const artifact = path.join(dir, "preview.HTML");
    await writeFile(artifact, "<!doctype html><html><body></body></html>");
    const resolved = await resolveAllowedArtifactFile(artifact);
    assert.equal(resolved, await realpath(artifact));
    assert.equal(artifactTreeRoot(resolved), path.dirname(resolved));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile accepts .htm", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const artifact = path.join(dir, "preview.htm");
    await writeFile(artifact, "<!doctype html><html><body></body></html>");
    assert.equal(path.basename(await resolveAllowedArtifactFile(artifact)), "preview.htm");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile refuses a non-HTML path without following it as a tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const secret = path.join(dir, "secret.txt");
    await writeFile(secret, "outside-secret\n");
    await assert.rejects(() => resolveAllowedArtifactFile(secret), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile refuses an HTML symlink whose real path is not HTML", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const secret = path.join(dir, "secret.txt");
    const decoy = path.join(dir, "decoy.html");
    await writeFile(secret, "outside-secret\n");
    await symlink(secret, decoy);
    await assert.rejects(() => resolveAllowedArtifactFile(decoy), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveAllowedArtifactFile refuses a directory whose name looks like HTML", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-artifact-path-"));
  try {
    const fake = path.join(dir, "site.html");
    await mkdir(fake);
    await assert.rejects(() => resolveAllowedArtifactFile(fake), {
      name: "ArtifactPathError",
      message: ARTIFACT_HTML_ERROR,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
