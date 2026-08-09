// dealernet: fonte unica de todo texto de INTERFACE, em pt-BR.
//
// Por que um arquivo so: o markup do chrome vive numa unica template string gigante em
// `createChromeHtml`. Traduzir la dentro colocaria nossas alteracoes exatamente no ponto que o
// upstream mais mexe, e cada merge viraria conflito. Com as strings aqui, o markup referencia
// chaves e o conflito fica confinado a este arquivo, que e nosso.
//
// Regra de escopo (importante): aqui entra so o que a PESSOA le. O texto dirigido ao AGENTE
// — `next_step`, guidance de poll, saida de `playbook`/`design` — continua em ingles: e calibrado
// nesse idioma, nao aparece na tela e traduzir so adicionaria risco.
//
// A traducao acontece em DOIS lugares por construcao, nao um: `chrome-client.js` e servido como
// arquivo cru e nao pode importar modulo, entao os textos dele viajam no bootstrap da sessao
// (`UI_CLIENTE`), e os do inbox de layout sao computados no servidor (`REGRAS_LAYOUT`).

// Marca exibida. Apenas apresentacao: `window.lavish`, `data-lavish-*`, o binario `lavish-axi` e
// as variaveis LAVISH_AXI_* NAO mudam — os playbooks instruem o agente a usar esses nomes.
/** @type {{ nome: string, complemento: string, tituloJanela: string, sufixoTitulo: string }} */
export const MARCA = Object.freeze({
  nome: "Dealernet",
  complemento: "Editor",
  tituloJanela: "Dealernet Editor",
  // Sufixo do titulo quando o artefato tem <title> proprio.
  sufixoTitulo: "Dealernet Editor",
});

/** @type {string} */
export const IDIOMA = "pt-BR";

// Textos renderizados pelo servidor dentro do chrome.
export const UI_CHROME = Object.freeze({
  problemasLayout: "Problemas de layout",
  selecionarTodos: "Selecionar todos",
  notaFila:
    "Enfileirar envia um pedido de correcao junto com o seu proximo feedback. Um problema so e dado como resolvido depois de um novo carregamento do artefato e de uma verificacao completa, no mesmo viewport, que nao o encontre mais.",
  enfileirarCorrecoes: "Enfileirar correcoes selecionadas",
  anotar: "Anotar",
  dicaModo: (tecla) => `Alternar entre anotar e explorar (⌘${tecla} / Ctrl+${tecla})`,
  mais: "Mais",
  edicao: "Edicao",
  copiarCaminho: "Copiar caminho",
  copiar: "Copiar",
  recarregarArtefato: "Recarregar artefato",
  copiarSnapshotDom: "Copiar snapshot do DOM",
  exportarHtml: "Exportar HTML autonomo",
  encerrarSessao: "Encerrar sessao",
  conversa: "Conversa",
  revisaoEmOutraAba: "Esta revisao esta aberta em outra aba do editor.",
  assumirAqui: "Assumir aqui",
  agenteNaoEscuta: "Seu agente nao esta escutando. Se continuar assim, peca a ele para aguardar novidades do editor.",
  placeholderMensagem: "Escreva uma mensagem para o agente...",
  dicaEnvio: "Escreva uma mensagem ou anote um elemento antes.",
  enviarEEncerrar: "Enviar e encerrar",
  enviarAoAgente: "Enviar ao agente",
  verificandoLayout: "Verificando o layout.<br>Um instante.",
  verificandoLayoutDetalhe: "O editor esta aguardando as fontes e a geometria final antes de revelar este artefato.",
  mostrarAssimMesmo: "Mostrar assim mesmo",
  sessaoEncerrada: "Sessao encerrada.<br>Volte ao seu agente para continuar.",
});

// Textos usados por `chrome-client.js`. Viajam no JSON de bootstrap da sessao porque o cliente e
// servido cru e nao pode importar este modulo.
//
// ATENCAO: tudo aqui tem de ser STRING. Este objeto passa por JSON.stringify para chegar ao
// cliente, e funcao nao sobrevive a serializacao — ela sumiria em silencio e o texto viraria
// `undefined` na tela. Onde precisa de interpolacao, use um marcador `{nome}` e `.replace()`.
export const UI_CLIENTE = Object.freeze({
  removerPromptDaFila: "Remover prompt da fila",
  revelar: "Revelar",
  revelarNoArtefato: "Revelar {titulo} no artefato",
  descartar: "Descartar",
  semProblemasLayout: "Nenhum problema de layout em aberto.",
  nenhumSelecionado: "Nenhum selecionado",
  copiado: "Copiado",
  copiar: "Copiar",
  naFilaParaEnvio: "Na fila para envio",
  corrigindoProblemaLayout: "Corrigindo um problema de layout...",
  exportarHtml: "Exportar HTML autonomo",
  exportarFalhou: "Falha ao exportar - tentar de novo",
  verificandoLayout: "Verificando o layout.<br>Um instante.",
  verificandoLayoutDetalhe: "O editor esta aguardando as fontes e a geometria final antes de revelar este artefato.",
  falhaGenerica: "Falha na operacao",
  falhaEnviarPrompts: "falha ao enviar os prompts da fila",
  falhaEncerrarSessao: "falha ao encerrar a sessao",
  falhaDescartarAviso: "falha ao descartar o aviso de layout",
  falhaEnfileirarCorrecoes: "falha ao enfileirar as correcoes de layout",
  falhaExportar: "falha ao exportar",
  revisaoInutilizavel: "a revisao esta inutilizavel",
  revisaoComProblemas: "a revisao tem problemas de layout",
});

// Titulos dos achados do inbox de layout. Ficam no servidor porque `serializeLayoutWarnings`
// computa o texto exibido — o chrome renderiza o que recebe e nunca decide sozinho.
export const REGRAS_LAYOUT = Object.freeze({
  "page-horizontal-overflow": "A pagina rola para o lado",
  "clipped-text": "Texto cortado pelo container",
  "clipped-control": "Controle cortado pelo container",
  "viewport-unreachable-control": "Controle fora da area visivel",
  "viewport-unreachable-content": "Texto fora da area visivel",
  "overlapping-text": "Texto coberto por outro elemento",
});

export const VIEWPORTS = Object.freeze({
  mobile: "Celular",
  compact: "Tablet / compacto",
  desktop: "Desktop",
});

export const ESTADOS_AVISO = Object.freeze({
  open: "Aberto",
  queued: "Correcao pedida",
  recurring: "Ainda presente",
  unverified: "Nao verificado",
  reopened: "Voltou",
  resolved: "Resolvido",
  dismissed: "Descartado",
  obsolete: "Obsoleto",
});
