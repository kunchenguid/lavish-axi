# Manutencao deste fork — rotina de acompanhamento do upstream

Este repositorio e um fork de trabalho de `kunchenguid/lavish-axi` (MIT), consumido **modificado** pelo
plugin `dealernet` do Claude Code. Ele nao e uma bifurcacao definitiva: o upstream continua sendo a
fonte de correcao de seguranca do produto, e ficar parado nele **e** o risco que esta rotina existe para
evitar.

O caso concreto: em julho/2026 o upstream corrigiu tres falhas de validacao de `Host` (DNS rebinding) —
`f016972`, `879794a`, `c229ef4`. Um fork congelado nao recebe a proxima.

## Topologia

| item        | valor                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `upstream`  | `https://github.com/kunchenguid/lavish-axi.git`                                                    |
| `origin`    | **nao existe** — o fork mora numa estacao e chega ao time vendorizado em `tools/lavish/` do plugin |
| `main`      | espelho do upstream, **intocado**                                                                  |
| `dealernet` | onde vivem todas as alteracoes nossas, uma por commit prefixado `dealernet:`                       |

`git log main..dealernet` e, a qualquer momento, a superficie inteira do fork. Se aparecer um commit sem
o prefixo `dealernet:`, ele entrou por engano.

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
git log --oneline main..upstream/main          # o que vem
git switch main && git merge --ff-only upstream/main
git switch dealernet && git merge main
```

`main` **sempre** avanca por fast-forward. Se `--ff-only` recusar, alguem commitou na `main`: mova esse
commit para a `dealernet` antes de continuar.

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
pnpm install
pnpm run check
```

O `check` roda build, lint, format, typecheck, `node --test`, `scripts/verificar-idioma.js` e
`build-skill --check`. O `verificar-idioma` e a guarda mecanica: ele falha se um termo-sentinela em
ingles reaparecer numa superficie que a pessoa le, se `<html lang="pt-BR">` ou a marca sairem, ou se a
API do artefato (`window.lavish`, `data-lavish-*`, `queuePrompt`) for renomeada.

**Baseline desta estacao: 580 passam / 2 falham.** As duas falhas sao ambientais e pre-existentes
(symlink em Windows sem Developer Mode): `CLAUDE.md ... symlink` (`EINVAL readlink`) e
`refuses to inline a local symlink ...` (`EPERM symlink`). Regressao se mede pelos **dois** numeros:
falha acima de 2 **ou** total abaixo de 580. Sem o piso, apagar um teste que falha viraria "verde".

## Revendorizar para o plugin

O bundle que o time recebe e o build **deste fork**, nunca o pacote do npm. Depois de um merge aceito:

```sh
node "<repo do plugin>/plugins/dealernet/scripts/vendorizar-lavish.mjs" --fork C:/Dev/Projects/Dealernet/lavish-axi
```

Ele roda o build, copia a arvore para `tools/lavish/` e regrava `lavish.pin.json` com versao, sha do
commit do fork e sha256 de cada arquivo. O `/dev-doctor` reprova se o que esta em disco divergir do pin.

Sem `origin`, **o `tools/lavish/` vendorizado e o unico backup real deste trabalho.** Enquanto for uma
pessoa mexendo no editor, e aceitavel; na segunda, deixa de ser e o fork precisa de um remoto.
