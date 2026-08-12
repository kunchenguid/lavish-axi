// @ts-check
import { readFile } from "node:fs/promises";

import * as esbuild from "esbuild";

for (const name of ["cli", "whiteboard"]) {
  const metafile = JSON.parse(await readFile(`.lavish-performance/build/${name}-metafile.json`, "utf8"));
  console.log(`\n${name} bundle\n`);
  console.log(await esbuild.analyzeMetafile(metafile));
}
