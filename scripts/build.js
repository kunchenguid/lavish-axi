import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// dealernet: limpar `dist` antes de gerar.
//
// O build so ESCREVIA por cima, e por isso a saida do quadro branco continuou em `dist/whiteboard`
// depois do recurso ser removido: 8,1 MB de codigo morto que ninguem produz mais e que ia junto em
// qualquer coisa que copiasse `dist/`. Medido em 2026-08-07 — o `dist` "de 9,6 MB" era 1,7 MB de build
// atual mais essa sobra.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);

// dealernet: um segundo artefato, AUTOCONTIDO, para vendorizacao dentro do plugin dealernet-claude.
//
// O `cli.mjs` acima e buildado com `packages: "external"` e depende de express, chokidar, parse5,
// axi-sdk-js e open em runtime — 254 pacotes que o plugin teria de carregar junto. Este aqui embute
// tudo num arquivo so (~1,6 MB), no mesmo padrao do `tools/gxcontext/gxcontext-cli.cjs`: um arquivo,
// um sha256 no pin, nenhum node_modules.
//
// Fica ao lado do `cli.mjs` de proposito: os assets (chrome-client.js, chrome.css, design/*) sao
// resolvidos por `new URL("./x", import.meta.url)`, entao o vendor so funciona se o bundle morar no
// mesmo diretorio que eles.
await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/lavish-vendor.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // express e chokidar chamam `require` em runtime; sem esta ponte o bundle ESM quebra ao carregar.
  banner: { js: 'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' },
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
    "process.env.LAVISH_AXI_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});
await chmod("dist/lavish-vendor.mjs", 0o755);
await copyFile("src/chrome-client.js", "dist/chrome-client.js");
await copyFile("src/chrome.css", "dist/chrome.css");
await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// dealernet: o bundle do quadro branco (Excalidraw + React + mermaid + fontes vendorizadas)
// foi removido junto com o recurso. Era 7,5 MB do total da arvore.
