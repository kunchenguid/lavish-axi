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

test("a rotina de upstream esta registrada em arquivo, com cadencia explicita", async () => {
  const texto = await readFile(rotina, "utf8");

  // Cadencia: gatilho por release do plugin E teto de tempo. Um sem o outro nao e cadencia.
  assert.match(texto, /a cada release do plugin/i);
  assert.match(texto, /30 dias/);

  // A mecanica que a pessoa executa, e o que ela roda depois.
  assert.match(texto, /git merge --ff-only upstream\/main/);
  assert.match(texto, /pnpm run check/);

  // O baseline, senao "regressao" volta a ser opiniao.
  assert.match(texto, /589 passam \/ 2 falham/);
});

test("AGENTS.md aponta para a rotina do fork", async () => {
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");

  assert.match(agents, /MANUTENCAO-FORK\.md/);
});
