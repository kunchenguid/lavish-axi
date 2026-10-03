import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isArtifactHtmlPage, resolveArtifactPage } from "../src/artifact-page.js";

test("artifact page resolution accepts same-root html files and rejects traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-artifact-page-"));
  try {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "index.html"), "<main>ok</main>");
    await writeFile(path.join(root, "real.html"), "<main>normalized</main>");
    await writeFile(path.join(root, "style.css"), "body {}\n");

    assert.equal(isArtifactHtmlPage("sub/index.html"), true);
    assert.equal(isArtifactHtmlPage("sub/index.HTM"), true);
    assert.equal(isArtifactHtmlPage("style.css"), false);
    assert.deepEqual(await resolveArtifactPage(root, "sub/index.html"), {
      file: await realpath(path.join(root, "sub", "index.html")),
      reason: "ok",
      page: "sub/index.html",
      servedRoute: "sub/index.html",
    });
    assert.deepEqual(await resolveArtifactPage(root, "sub/../real.html"), {
      file: await realpath(path.join(root, "real.html")),
      reason: "ok",
      page: "real.html",
      servedRoute: "sub/../real.html",
    });
    assert.deepEqual(await resolveArtifactPage(root, "../outside.html"), {
      file: null,
      reason: "forbidden",
      page: null,
      servedRoute: null,
    });
    assert.deepEqual(await resolveArtifactPage(root, "style.css"), {
      file: null,
      reason: "forbidden",
      page: null,
      servedRoute: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dot-prefixed in-root names are not parent traversal, including the exact saved entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-dot-prefix-"));
  try {
    await mkdir(path.join(root, "..pages"));
    for (const page of ["..report.html", "..pages/page.html"]) {
      await writeFile(path.join(root, page), "<!doctype html><p>inside</p>");
      assert.equal((await resolveArtifactPage(root, page)).reason, "ok");
    }
    assert.equal(
      (await resolveArtifactPage(root, "..report.html", { entryFile: "..report.html" })).page,
      "..report.html",
    );
    for (const page of [
      "../outside.html",
      "..\\outside.html",
      "..pages/../../outside.html",
      "..pages\\..\\..\\outside.html",
    ]) {
      assert.equal((await resolveArtifactPage(root, page)).reason, "forbidden");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact page resolution accepts internal aliases and rejects escaping links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-artifact-page-"));
  const outside = await mkdtemp(path.join(tmpdir(), "lavish-artifact-page-outside-"));
  try {
    await writeFile(path.join(root, "real.html"), "<main>inside</main>");
    await symlink(path.join(root, "real.html"), path.join(root, "alias.html"));
    await writeFile(path.join(root, "notes.txt"), "plain text");
    await symlink(path.join(root, "notes.txt"), path.join(root, "looks-like-html.html"));
    await writeFile(path.join(outside, "outside.html"), "<main>outside</main>");
    await symlink(path.join(outside, "outside.html"), path.join(root, "linked.html"));
    assert.deepEqual(await resolveArtifactPage(root, "alias.html"), {
      file: await realpath(path.join(root, "real.html")),
      reason: "ok",
      page: "real.html",
      servedRoute: "alias.html",
    });
    assert.deepEqual(await resolveArtifactPage(root, "linked.html"), {
      file: null,
      reason: "forbidden",
      page: null,
      servedRoute: null,
    });
    assert.deepEqual(await resolveArtifactPage(root, "looks-like-html.html"), {
      file: null,
      reason: "forbidden",
      page: null,
      servedRoute: null,
    });
    assert.deepEqual(await resolveArtifactPage(root, "looks-like-html.html", { entryFile: "looks-like-html.html" }), {
      file: await realpath(path.join(root, "notes.txt")),
      reason: "ok",
      page: "notes.txt",
      servedRoute: "looks-like-html.html",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
