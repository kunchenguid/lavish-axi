import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// The executable override runs an isolated headless browser without changing the installed CLI.
// Without it, retain the browser command used by the other opt-in suites.
export async function conversationBrowser(temp, session) {
  const executable = process.env.LAVISH_AXI_CHROME_PATH;
  if (!executable) {
    const run = (args) => {
      const result = spawnSync("chrome-devtools-axi", args, {
        env: {
          ...process.env,
          CHROME_DEVTOOLS_AXI_SESSION: session,
          CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
        },
        encoding: "utf8",
        timeout: 45_000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    };
    return {
      async evaluate(expression) {
        const output = run(["eval", expression]);
        const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
        assert.ok(raw, output);
        return decode(JSON.parse(raw));
      },
      async emulate(viewport) {
        run(["emulate", "--viewport", viewport]);
      },
      async open(url) {
        run(["open", url]);
      },
      async stop() {
        run(["stop"]);
      },
    };
  }

  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(temp, "chrome")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let socket;
  const stop = async () => {
    socket?.close();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${stderr}`)), 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited: ${stderr}`));
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const origin = new URL(String(endpoint));
    const response = await fetch(`http://${origin.host}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
    });
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      clearTimeout(handler.timer);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise(
        /** @param {(value: any) => void} resolve */ (resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out`));
          }, 15_000);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, method, params }));
        },
      );
    await send("Page.enable");
    return {
      async evaluate(expression) {
        const result = await send("Runtime.evaluate", {
          expression: `(${expression})()`,
          awaitPromise: true,
          returnByValue: true,
        });
        assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
        return decode(result.result.value);
      },
      async emulate(viewport) {
        const [dimensions, ...flags] = viewport.split(",");
        const [width, height, deviceScaleFactor] = dimensions.split("x").map(Number);
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor,
          mobile: flags.includes("mobile"),
        });
        await send("Emulation.setTouchEmulationEnabled", { enabled: flags.includes("touch") });
      },
      async open(url) {
        let timer;
        let onMessage;
        const loaded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Page load timed out")), 15_000);
          onMessage = (event) => {
            if (JSON.parse(String(event.data)).method === "Page.loadEventFired") resolve(undefined);
          };
          socket.addEventListener("message", onMessage);
        });
        try {
          await Promise.all([send("Page.navigate", { url }), loaded]);
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
        }
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function decode(value) {
  while (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

export async function waitForBrowser(browser, expression) {
  const deadline = Date.now() + 10_000;
  do {
    if (await browser.evaluate(expression)) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`Browser condition timed out: ${expression}`);
}
