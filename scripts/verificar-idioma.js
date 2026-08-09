// dealernet: guarda mecanica da localizacao pt-BR.
//
// A interface desta build e em portugues. O jeito de isso NAO regredir aos poucos — um merge do
// upstream aqui, uma string nova ali — nao e revisao visual: e este check, que roda no
// `pnpm run check` e falha se um termo-sentinela em ingles aparecer numa superficie que a PESSOA le.
//
// Escopo deliberado: so o que e exibido. Texto dirigido ao AGENTE (`next_step`, guidance de poll,
// saida de `playbook`/`design`) continua em ingles de proposito e nao e varrido.

import { readFileSync } from "node:fs";

import { createChromeHtml, createSdkJs } from "../src/server.js";
import { describeLayoutWarning, layoutWarningStatusLabel, viewportClassLabel } from "../src/layout-warnings.js";

// Termos que so aparecem se uma string de interface voltou ao ingles. Cada um ja esteve no produto.
const SENTINELAS = [
  "Send to Agent",
  "Send &amp; End",
  "End session",
  "Layout issues",
  "Select all",
  "Queue selected fixes",
  "Reload artifact",
  "Copy DOM snapshot",
  "Export standalone HTML",
  "Copy path",
  "Conversation",
  "Show anyway",
  "Session ended",
  "Checking layout",
  "Write a message",
  "Take over here",
  "is not listening",
  "No unresolved",
  "None selected",
  "Queued for send",
  "Publish",
  "ht-ml",
  "Whiteboard",
  "Lavish Editor",
  "Agent hasn't sent a message yet",
  "Click an element in the artifact to annotate",
  "Severe",
  "Seen just now",
  "m ago",
  "h ago",
  "d ago",
];

const superficies = [];

// 1) o HTML do chrome, com e sem gate
for (const layoutGateEnabled of [true, false]) {
  superficies.push([
    `createChromeHtml(layoutGate=${layoutGateEnabled})`,
    createChromeHtml({ key: "0123456789abcdef", file: "/tmp/artefato.html" }, { layoutGateEnabled }),
  ]);
}

// 2) o cliente servido cru — nao passa pelo bootstrap, entao literal em ingles aqui e regressao.
// Comentario de linha inteira sai antes da varredura: o codigo do upstream e comentado em ingles,
// e comentario nao chega na tela. So o que pode virar texto exibido e verificado.
const clienteSemComentarios = readFileSync(new URL("../src/chrome-client.js", import.meta.url), "utf8")
  .split("\n")
  .filter((linha) => !linha.trimStart().startsWith("//"))
  .join("\n");
superficies.push(["src/chrome-client.js", clienteSemComentarios]);

// 3) CSS também exibe texto: o estado vazio da conversa é um pseudo-elemento `::before`.
// Sem incluir esta superfície, o checker aprovava uma frase inteira em inglês observada no browser.
// Comentários são removidos pelo mesmo motivo dos comentários do cliente acima.
const cssSemComentarios = readFileSync(new URL("../src/chrome.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
superficies.push(["src/chrome.css", cssSemComentarios]);

// 4) o texto do inbox, que e computado no servidor
const regras = [
  "page-horizontal-overflow",
  "clipped-text",
  "clipped-control",
  "viewport-unreachable-control",
  "viewport-unreachable-content",
  "overlapping-text",
];
const textoInbox = [
  ...regras.map((rule) => {
    const { title, explanation } = describeLayoutWarning({
      rule,
      axis: "horizontal",
      overflowPx: 42,
      viewportWidth: 800,
    });
    return `${title} ${explanation}`;
  }),
  ...["mobile", "compact", "desktop"].map(viewportClassLabel),
  ...["open", "queued", "recurring", "unverified", "reopened", "resolved", "dismissed", "obsolete"].map(
    layoutWarningStatusLabel,
  ),
  describeLayoutWarning({ rule: "regra-desconhecida" }).title,
].join("\n");
superficies.push(["layout-warnings (texto exibido)", textoInbox]);

const falhas = [];
for (const [nome, conteudo] of superficies) {
  for (const termo of SENTINELAS) {
    if (conteudo.includes(termo)) falhas.push(`${nome}: encontrou "${termo}"`);
  }
}

// 5) o idioma declarado e a marca
const chrome = superficies[0][1];
if (!chrome.includes('<html lang="pt-BR">')) falhas.push('createChromeHtml: falta <html lang="pt-BR">');
if (!chrome.includes(">Dealernet<")) falhas.push("createChromeHtml: a marca nao exibe Dealernet");

// 6) a API dos artefatos NAO pode ser renomeada — os playbooks instruem o agente a usar estes nomes
const sdk = createSdkJs("0123456789abcdef", 1, "token");
for (const obrigatorio of [".lavish = {", "data-lavish-action", "queuePrompt", "data-lavish-question"]) {
  if (!sdk.includes(obrigatorio)) falhas.push(`SDK: perdeu "${obrigatorio}" — contrato com os playbooks`);
}

if (falhas.length) {
  console.error(`verificar-idioma: ${falhas.length} problema(s)`);
  for (const f of falhas) console.error("  " + f);
  process.exit(1);
}
console.log(`verificar-idioma: ok (${superficies.length} superficies, ${SENTINELAS.length} sentinelas)`);
