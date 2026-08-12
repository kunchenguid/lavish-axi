# Manutencao deste fork — rotina de acompanhamento do upstream

Este repositorio e um fork de trabalho de `kunchenguid/lavish-axi` (MIT), consumido **modificado** pelo
plugin `dealernet` do Claude Code. Ele nao e uma bifurcacao definitiva: o upstream continua sendo a
fonte de correcao de seguranca do produto, e ficar parado nele **e** o risco que esta rotina existe para
evitar.

O caso concreto: em julho/2026 o upstream corrigiu tres falhas de validacao de `Host` (DNS rebinding) —
`f016972`, `879794a`, `c229ef4`. Um fork congelado nao recebe a proxima.

## Topologia

| item       | valor                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| `upstream` | `https://github.com/kunchenguid/lavish-axi.git` — produto publico, somente leitura     |
| `origin`   | `https://github.com/rodrigoreisdealernet/lavish-axi.git` — fork interno versionado     |
| `main`     | unica branch persistente; contem o upstream mais todas as alteracoes Dealernet aceitas |

Mudancas e sincronizacoes nascem em `agent/*`, entram por PR em `main` e têm a branch removida depois do
merge. Assim, `origin/main` e a fonte exata do bundle vendorizado e nao existe uma segunda linha local
permanente que possa divergir em silencio.

### Versao da build interna

`package.json` na branch `dealernet` usa `<versao-base>-dealernet.<N>` e incrementa `N` em toda mudanca
que sera vendorizada. A versao nao e cosmetica: ela viaja no `/health`, e o CLI so substitui um servidor
persistente quando essa string muda. Sem o sufixo proprio, um plugin atualizado pode continuar servindo
o chrome de uma build anterior. `.release-please-manifest.json` permanece na versao do upstream; este
fork nao publica pacote npm nem se faz passar por uma release que nao incorporou integralmente.

## Cadencia

Conferir o upstream **a cada release do plugin `dealernet`** e, independente de release, **no maximo a
cada 30 dias**. Quem esquece nao descobre: o `/dev-doctor` imprime a distancia em commits entre `main` e
`upstream/main` em toda execucao, e e esse numero que dispara a rotina.

Mesclar de verdade quando qualquer uma valer:

- a distancia passou de **20 commits** — quanto maior o intervalo, mais caro o conflito de i18n;
- o upstream publicou correcao de **seguranca** ou de **validacao de entrada** (o caso do `Host`);
- vamos revendorizar o bundle para o plugin de todo jeito.

## Passo a passo do merge

```sh
cd C:/Dev/Projects/Dealernet/lavish-axi
git fetch upstream
git switch main && git pull --ff-only origin main
git switch -c agent/sincronizar-upstream
git log --oneline main..upstream/main          # o que vem
git merge upstream/main
pnpm run check
git push -u origin agent/sincronizar-upstream  # abrir PR para main e remover a branch apos o merge
```

Nunca envie diretamente para `upstream`. Se o merge conflitar, resolva somente na branch temporaria e
mantenha `main` igual a `origin/main` ate o PR ser aceito.

### Onde o conflito cai, e por que ali

1. **`src/i18n-ptbr.js`** — arquivo nosso, criado justamente para concentrar o conflito. Resolver aqui e
   traduzir a string nova, nada mais.
2. **`src/server.js`, em `createChromeHtml`** — o markup do chrome e uma unica template string grande, e
   e onde o upstream mais mexe. Aceite o markup deles e reponha as referencias a `UI_CHROME`, `lang` e a
   marca. **Nao** reponha texto em ingles direto no markup.
3. **`src/chrome-client.js`** — servido cru, le os textos de `sessionData.i18n` como `t`. String nova do
   upstream tem de virar chave em `UI_CLIENTE`.
4. **Superficies removidas** (`share`, `setup hooks`, telemetria, quadro branco) — se o merge as trouxer
   de volta, **remova outra vez**. Elas sao proibidas por decisao, nao por acidente; ver a lista em
   `AGENTS.md` e os commits `6907d5d` e `fb672b4`.

### Depois do merge, nesta ordem

```sh
# incremente o sufixo -dealernet.N de package.json antes do build
pnpm install
pnpm run check
```

O `check` roda build, lint, format, typecheck, `node --test`, `scripts/verificar-idioma.js` e
`build-skill --check`. O `verificar-idioma` e a guarda mecanica: ele falha se um termo-sentinela em
ingles reaparecer numa superficie que a pessoa le, se `<html lang="pt-BR">` ou a marca sairem, ou se a
API do artefato (`window.lavish`, `data-lavish-*`, `queuePrompt`) for renomeada.

**Baseline desta estacao: 612 testes — 609 passam / 0 falham / 3 pulados.** Regressao se mede por todos
os numeros: qualquer falha, menos de 609 passes ou menos de 612 testes. Sem os pisos, apagar um teste
que falha viraria "verde".

## Revendorizar para o plugin

O bundle que o time recebe e o build **deste fork**, nunca o pacote do npm. Depois de um merge aceito:

```sh
node "<repo do plugin>/plugins/dealernet/scripts/vendorizar-lavish.mjs" --fork C:/Dev/Projects/Dealernet/lavish-axi
```

Ele roda o build, copia a arvore para `tools/lavish/` e regrava `lavish.pin.json` com versao, sha do
commit do fork e sha256 de cada arquivo. O `/dev-doctor` reprova se o que esta em disco divergir do pin.

O commit registrado em `lavish.pin.json` precisa existir em `origin/main`; nao vendorize commit apenas
local nem uma branch temporaria.
