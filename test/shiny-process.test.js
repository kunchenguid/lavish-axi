import assert from "node:assert/strict";
import test from "node:test";
import { detectRscript, findFreePort, launchShiny } from "../src/shiny-process.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("findFreePort returns a valid port number", async () => {
  const port1 = await findFreePort();
  const port2 = await findFreePort();

  assert.equal(typeof port1, "number");
  assert.equal(typeof port2, "number");
  assert.ok(port1 > 0 && port1 < 65536);
  assert.ok(port2 > 0 && port2 < 65536);
});

test("detectRscript returns ok=true when R and shiny are installed", async () => {
  const result = await detectRscript();
  // Since R and shiny are installed on the development machine, this should be true.
  assert.equal(result.ok, true);
  assert.match(result.version, /Rscript/i);
});

test("launchShiny starts a Shiny app and kills it successfully", async () => {
  // Create a temporary directory for the Shiny app
  const tempDir = await mkdtemp(path.join(tmpdir(), "lavish-shiny-test-"));
  const appContent = `
library(shiny)
ui <- fluidPage(
  tags$h1("Test Shiny App"),
  textInput("text", "Input text", "hello")
)
server <- function(input, output) {}
shinyApp(ui, server)
`;

  try {
    await writeFile(path.join(tempDir, "app.R"), appContent, "utf8");
    const port = await findFreePort();

    // Launch the app
    const shiny = await launchShiny(tempDir, { port, host: "127.0.0.1" });

    assert.equal(shiny.port, port);
    assert.equal(shiny.url, `http://127.0.0.1:${port}`);
    assert.ok(shiny.process.pid);

    // Verify we can fetch the page
    const response = await fetch(shiny.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Test Shiny App/);

    // Kill the process
    shiny.kill();

    // Verify the process is killed (exited)
    await new Promise((resolve) => {
      if (shiny.process.killed || shiny.process.exitCode !== null) {
        resolve();
      } else {
        shiny.process.on("exit", () => resolve());
      }
    });
  } finally {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
