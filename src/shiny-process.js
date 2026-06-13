import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { access } from "node:fs/promises";

/**
 * Detects if Rscript is available and if the shiny package is installed.
 * @returns {Promise<{ ok: boolean; version?: string; error?: string }>}
 */
export async function detectRscript() {
  try {
    const rscript = spawnSync("Rscript", ["--version"]);
    if (rscript.status !== 0) {
      return { ok: false, error: "Rscript command not found on PATH or exited with non-zero status" };
    }
    // Rscript version is often printed to stderr or stdout depending on OS/version.
    const versionOutput = (rscript.stderr.toString() + rscript.stdout.toString()).trim();

    // Check if shiny package is installed
    const shinyCheck = spawnSync("Rscript", ["-e", "library(shiny)"]);
    if (shinyCheck.status !== 0) {
      return { ok: false, version: versionOutput, error: "R package 'shiny' is not installed" };
    }

    return { ok: true, version: versionOutput };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Finds a free port on localhost.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) {
          reject(new Error("Failed to acquire a valid free port"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * Launches a Shiny app process in the background.
 * @param {string} appDir Absolute path to the Shiny app directory
 * @param {object} options
 * @param {number} options.port Port to run Shiny on
 * @param {string} [options.host] Host to run Shiny on (default: 127.0.0.1)
 * @param {AbortSignal} [options.signal] AbortSignal to kill the process
 * @param {function} [options.log] Log function for stdout/stderr
 * @returns {Promise<{ process: import("child_process").ChildProcess; port: number; url: string; kill: () => void }>}
 */
export async function launchShiny(appDir, { port, host = "127.0.0.1", signal, log }) {
  // Verify appDir exists
  await access(appDir);

  const rCommand = `options(shiny.autoreload = FALSE); shiny::runApp('.', port = ${port}, host = '${host}', launch.browser = FALSE)`;

  const child = spawn("Rscript", ["-e", rCommand], {
    cwd: appDir,
    env: { ...process.env },
    signal,
  });

  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`[shiny] ${line}\n`);

  child.stdout?.on("data", (data) => {
    const text = data.toString();
    text.split("\n").forEach((line) => {
      if (line.trim()) writeLog(`stdout: ${line}`);
    });
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    text.split("\n").forEach((line) => {
      if (line.trim()) writeLog(`stderr: ${line}`);
    });
  });

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    child.kill("SIGTERM");
  };

  // Wait for Shiny server to become responsive
  const url = `http://${host}:${port}`;
  const deadline = Date.now() + 30000; // 30 second timeout
  let isReady = false;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Shiny process exited prematurely with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok || response.status === 404 || response.status === 403 || response.status === 200) {
        isReady = true;
        break;
      }
    } catch {
      // Ignore network errors while waiting for start
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!isReady) {
    kill();
    throw new Error(`Shiny process at ${url} did not respond within 30 seconds`);
  }

  return {
    process: child,
    port,
    url,
    kill,
  };
}
