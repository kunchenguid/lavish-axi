// dealernet: a saida em JSON e o handshake com o plugin que consome esta build.
//
// Sem ela o plugin teria de parsear TOON com regex — e a primeira chave nova do upstream quebraria o
// parser em silencio, num ponto onde "silencio" significa a trilha achar que a vista nao subiu.

import assert from "node:assert/strict";
import test from "node:test";

import { comSaidaJson, saidaEmJson } from "../src/cli.js";

test("`update` falha com mensagem RENDERIZADA e exit 2, nao com stack trace", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["bin/lavish-axi.js", "update"], {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\//, ""),
    encoding: "utf8",
    env: { ...process.env, LAVISH_AXI_STATE_DIR: `${process.env.TEMP || "/tmp"}/lavish-teste-update` },
  });
  const saida = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, saida);
  assert.match(saida, /esta desabilitado nesta build/);
  assert.match(saida, /build Dealernet/);
  assert.doesNotMatch(saida, /at assertCommandAllowed|AxiError: /, "stack trace no lugar da mensagem e o defeito");
});

test("saidaEmJson so liga com LAVISH_AXI_JSON=1 exato", () => {
  assert.equal(saidaEmJson({ LAVISH_AXI_JSON: "1" }), true);
  assert.equal(saidaEmJson({ LAVISH_AXI_JSON: "true" }), false);
  assert.equal(saidaEmJson({}), false);
});

test("com a variavel ligada, o comando devolve JSON parseavel do MESMO objeto", async () => {
  const objeto = { session: { file: "/w/parecer.html", url: "http://127.0.0.1:4387/session/abc", status: "opened" } };
  const embrulhado = comSaidaJson(async () => objeto, { LAVISH_AXI_JSON: "1" });

  const saida = await embrulhado([]);
  assert.equal(typeof saida, "string");
  assert.deepEqual(JSON.parse(saida), objeto, "nada pode se perder na conversao");
});

test("sem a variavel, o objeto passa intacto e o SDK segue renderizando TOON", async () => {
  const objeto = { session: { status: "ended" } };
  const saida = await comSaidaJson(async () => objeto, {})([]);
  assert.equal(saida, objeto, "o comportamento padrao da build nao muda");
});

test("comando que ja devolve string passa direto — renderOutput a imprime verbatim", async () => {
  const embrulhado = comSaidaJson(async () => "texto do playbook", { LAVISH_AXI_JSON: "1" });
  assert.equal(await embrulhado([]), "texto do playbook");
});

test("comando sem retorno continua sem retorno", async () => {
  const embrulhado = comSaidaJson(async () => undefined, { LAVISH_AXI_JSON: "1" });
  assert.equal(await embrulhado([]), undefined);
});

test("o erro do comando continua subindo — JSON nao pode engolir falha", async () => {
  const embrulhado = comSaidaJson(
    async () => {
      throw new Error("porta ocupada");
    },
    { LAVISH_AXI_JSON: "1" },
  );
  await assert.rejects(() => embrulhado([]), /porta ocupada/);
});
