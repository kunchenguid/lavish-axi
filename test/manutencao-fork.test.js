// dealernet: a rotina de acompanhamento do upstream tem de continuar existindo, e ser achavel.
//
// Sem isto, o arquivo e uma folha solta: um merge do upstream que o remova, ou um AGENTS.md que pare de
// apontar para ele, passa sem ninguem notar — e "conferir o upstream" volta a depender da memoria de
// quem fez o fork. O risco concreto esta registrado no proprio documento: o upstream corrigiu tres
// falhas de validacao de Host em julho/2026.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rotina = new URL("../MANUTENCAO-FORK.md", import.meta.url);
const readme = new URL("../README.md", import.meta.url);
const avisos = new URL("../THIRD-PARTY-NOTICES.md", import.meta.url);

test("a rotina de upstream esta registrada em arquivo, com cadencia explicita", async () => {
  const texto = await readFile(rotina, "utf8");

  // Cadencia: gatilho por release do plugin E teto de tempo. Um sem o outro nao e cadencia.
  assert.match(texto, /a cada release do plugin/i);
  assert.match(texto, /30 dias/);

  // A mecanica que a pessoa executa, e o que ela roda depois.
  assert.match(texto, /git merge upstream\/main/);
  assert.match(texto, /pnpm run check/);

  // O baseline, senao "regressao" volta a ser opiniao.
  assert.match(texto, /609 passam \/ 0 falham/);
});

test("AGENTS.md aponta para a rotina do fork", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

  assert.match(agents, /MANUTENCAO-FORK\.md/);
});

test("README descreve a build Dealernet sem recomendar superficies removidas", async () => {
  const texto = await readFile(readme, "utf8");

  assert.match(texto, /build Dealernet/i);
  assert.match(texto, /vendorizada no plugin `dealernet`/i);
  assert.doesNotMatch(texto, /`lavish-axi (?:share|setup hooks|update)(?:\s|`)/i);
  assert.doesNotMatch(texto, /editable Excalidraw whiteboard/i);
});

test("avisos de terceiros descrevem o bundle atual, sem o quadro branco removido", async () => {
  const texto = await readFile(avisos, "utf8");

  assert.match(texto, /dist\/lavish-vendor\.mjs/);
  assert.match(texto, /dealernet-claude\/THIRD-PARTY-NOTICES\.md/);
  assert.doesNotMatch(texto, /dist\/whiteboard/i);
  assert.doesNotMatch(texto, /Bundled into[^\n]*whiteboard|Fonts vendored into/i);
});
