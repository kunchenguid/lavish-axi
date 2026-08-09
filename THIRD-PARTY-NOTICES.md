# Avisos de terceiros — build Dealernet

Esta branch é a fonte do bundle interno do Lavish Editor distribuído pelo plugin `dealernet`. Ela não
é publicada no npm. O build limpa `dist/` antes de gerar os artefatos e não inclui quadro branco,
Excalidraw, React, Mermaid vendorizado nem fontes do recurso removido.

## Bundle do plugin

`dist/lavish-vendor.mjs` embute as dependências de runtime resolvidas pelo lockfile. Ele só é
redistribuído depois que `dealernet-claude/plugins/dealernet/scripts/vendorizar-lavish.mjs` copia e
pina o build. Esse processo leva este arquivo e o texto MIT de `LICENSE` para dentro do diretório do
plugin; a visão consolidada do marketplace fica em `dealernet-claude/THIRD-PARTY-NOTICES.md`.

As dependências diretas de runtime do bundle são:

| Pacote       | Licença | Papel                                 |
| ------------ | ------- | ------------------------------------- |
| `axi-sdk-js` | MIT     | roteamento e contrato de saída do CLI |
| `chokidar`   | MIT     | observação do artefato para recarga   |
| `express`    | MIT     | servidor HTTP local                   |
| `open`       | MIT     | abertura do navegador                 |
| `parse5`     | MIT     | parsing seguro do HTML                |

O inventário resolvido, incluindo transitivas e versões exatas, é verificável no checkout com
`pnpm licenses list --prod` e `pnpm-lock.yaml`. Alterar dependências ou o lockfile exige repetir essa
auditoria antes de revendorizar.

## Assets em `dist/design/`

| Asset                               | Pacote                 | Licença |
| ----------------------------------- | ---------------------- | ------- |
| `daisyui.css`, `daisyui-themes.css` | `daisyui`              | MIT     |
| `tailwindcss-browser.js`            | `@tailwindcss/browser` | MIT     |

Esses assets são copiados dos pacotes resolvidos pelo lockfile e entram no mesmo pin sha256 do bundle.
