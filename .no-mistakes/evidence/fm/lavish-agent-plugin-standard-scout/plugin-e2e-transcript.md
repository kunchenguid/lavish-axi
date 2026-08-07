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
  copilot,absent,copilot CLI not found on PATH

$ <installed-package>/dist/cli.mjs setup plugin
clients[3]{client,status,detail}:
  vscode,absent,no VS Code user configuration found
  cursor,current,~/.cursor/plugins/local/lavish-axi
  copilot,absent,copilot CLI not found on PATH
```

The second invocation reported `current`, demonstrating idempotence. The registered Cursor symlink resolved to the installed npm package root:

```text
plugin.json: present
skills/lavish/SKILL.md: present
mcp.json: absent
```

The isolated `PATH` did not expose Copilot. Focused automated tests separately exercised successful, current, repaired, failed, and invalid-record Copilot responses through its executable CLI boundary.

## External standards validation

```text
$ uvx --from skills-ref agentskills validate skills/lavish
Valid skill: skills/lavish

$ curl --fail --silent --show-error \
    https://agent-plugins.org/schemas/1.0.0/plugin.schema.json \
    --output <temporary-schema-file>
$ npx -y ajv-cli@5 validate --spec=draft2020 \
    -s <temporary-schema-file> \
    -d plugin.json
plugin.json valid
```

The temporary schema file was removed after validation.

## Windows CI verdict

The required Windows verdict is not yet available for this test phase. The latest PR run reports the Windows matrix job as cancelled, which `gh-axi pr checks 223` summarizes as skipped:

```text
$ gh-axi pr checks 223
summary: "4 passed, 0 failed, 1 skipped, 5 total"
checks[5]{name,conclusion}:
  build-and-test (ubuntu-latest),pass
  Generated files must not be hand-edited,pass
  PR must be raised via no-mistakes,pass
  build-and-test (macos-latest),pass
  build-and-test (windows-latest),skip
```

The outer pipeline still needs to produce the explicitly required real `windows-latest` result.
