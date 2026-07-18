import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const chromeClientEntryPoint = fileURLToPath(new URL("../src/chrome-client.js", import.meta.url));

export function buildChromeClient(options = {}) {
  return esbuild.build({
    entryPoints: [chromeClientEntryPoint],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    ...options,
  });
}
