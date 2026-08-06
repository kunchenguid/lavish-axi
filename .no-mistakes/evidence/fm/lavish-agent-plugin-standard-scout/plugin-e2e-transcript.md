# Self-contained Agent Plugin verification

Validated the published artifact from an isolated install, using `npm pack`, `npm install --ignore-scripts <tarball>`, and the installed `dist/cli.mjs`.

## Published tarball contract

```text
$ tar -tzf lavish-axi-0.1.45.tgz | rg '^package/(plugin.json|skills/lavish/SKILL.md|mcp.json)$'
package/plugin.json
package/skills/lavish/SKILL.md
```

The package contains the root manifest and exactly one public Lavish skill. It contains no `mcp.json`.

## Installed CLI registration

The isolated HOME exposed Cursor as an installed client. Running the CLI from the unpacked npm package produced:

```text
$ <installed-package>/dist/cli.mjs setup plugin
plugin:
  name: lavish-axi
  root: <installed-package>/node_modules/lavish-axi
clients[3]{client,status,detail}:
  vscode,absent,no VS Code user configuration found
  cursor,registered,~/.cursor/plugins/local/lavish-axi
  copilot,manual,"could not verify installed plugins: The plugins command is not available."

$ <installed-package>/dist/cli.mjs setup plugin
clients[3]{client,status,detail}:
  vscode,absent,no VS Code user configuration found
  cursor,current,~/.cursor/plugins/local/lavish-axi
  copilot,manual,"could not verify installed plugins: The plugins command is not available."
```

The second invocation reported `current`, demonstrating idempotence. The registered Cursor symlink resolved to the installed npm package root:

```text
plugin.json: present
skills/lavish/SKILL.md: present
mcp.json: absent
```

The host's `copilot` executable does not expose a usable plugins command, so the CLI correctly requested manual handling without changing registration. Focused automated tests separately exercised successful, current, repaired, failed, and invalid-record Copilot responses through its executable CLI boundary.

## External standards validation

```text
$ uvx --from skills-ref agentskills validate skills/lavish
Valid skill: skills/lavish

$ npx -y ajv-cli@5 validate --spec=draft2020 \
    -s https://agent-plugins.org/schemas/1.0.0/plugin.schema.json \
    -d plugin.json
plugin.json valid
```

The AJV command used a freshly downloaded copy of the canonical schema URL as its schema input.
