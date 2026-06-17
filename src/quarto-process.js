import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Detects if quarto is available on the PATH.
 * @returns {Promise<{ ok: boolean; version?: string; error?: string }>}
 */
export async function detectQuarto() {
  try {
    const quarto = spawnSync("quarto", ["--version"]);
    if (quarto.status !== 0) {
      return { ok: false, error: "quarto command not found on PATH or exited with non-zero status" };
    }
    const versionOutput = (quarto.stdout.toString() || quarto.stderr.toString()).trim();
    return { ok: true, version: versionOutput };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Derives the expected HTML output file path from a QMD/RMD file path.
 * @param {string} qmdFile Absolute path to the source file
 * @returns {string} Absolute path to the expected output HTML file
 */
export function quartoOutputFile(qmdFile) {
  const parsed = path.parse(qmdFile);
  return path.join(parsed.dir, parsed.name + ".html");
}

/**
 * Runs quarto render to convert a QMD/RMD/MD file to HTML.
 * @param {string} qmdFile Absolute path to the source file
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] AbortSignal to cancel the render
 * @param {function} [options.log] Log function for stdout/stderr
 * @returns {Promise<{ ok: boolean; outputFile?: string; error?: string }>}
 */
export function renderQuarto(qmdFile, { signal, log } = {}) {
  return new Promise((resolve) => {
    access(qmdFile)
      .then(() => {
        const child = spawn("quarto", ["render", qmdFile, "--to", "html"], {
          cwd: path.dirname(qmdFile),
          env: { ...process.env },
          signal,
        });

        const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`[quarto] ${line}\n`);

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

        child.on("close", (code) => {
          if (code === 0) {
            resolve({ ok: true, outputFile: quartoOutputFile(qmdFile) });
          } else {
            resolve({ ok: false, error: `quarto render exited with code ${code}` });
          }
        });

        child.on("error", (err) => {
          if (err.name === "AbortError" || (signal && signal.aborted)) {
            resolve({ ok: false, error: "quarto render aborted" });
          } else {
            resolve({ ok: false, error: err.message });
          }
        });
      })
      .catch(() => {
        resolve({ ok: false, error: `File not found: ${qmdFile}` });
      });
  });
}

/**
 * Checks if the Quarto file has a Shiny server configuration in its YAML front-matter.
 * @param {string} qmdFile Absolute path to the file
 * @returns {Promise<boolean>}
 */
export async function isQuartoShinyFile(qmdFile) {
  try {
    const content = await readFile(qmdFile, "utf8");
    const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontMatterMatch) return false;
    const yaml = frontMatterMatch[1];
    return /\bserver\s*:\s*shiny\b/i.test(yaml) || /\bserver\s*:\s*\r?\n\s+type\s*:\s*shiny\b/i.test(yaml);
  } catch {
    return false;
  }
}

/**
 * Launches an interactive Quarto Shiny document process in the background.
 * @param {string} qmdFile Absolute path to the source file
 * @param {object} options
 * @param {number} options.port Port to run on
 * @param {string} [options.host] Host to run on (default: 127.0.0.1)
 * @param {AbortSignal} [options.signal] AbortSignal to kill the process
 * @param {function} [options.log] Log function for stdout/stderr
 * @returns {Promise<{ process: import("child_process").ChildProcess; port: number; url: string; kill: () => void }>}
 */
export async function launchQuartoShiny(qmdFile, { port, host = "127.0.0.1", signal, log }) {
  await access(qmdFile);

  const child = spawn("quarto", ["serve", qmdFile, "--port", String(port), "--host", host], {
    cwd: path.dirname(qmdFile),
    env: { ...process.env },
    signal,
    detached: true,
  });

  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`[quarto-shiny] ${line}\n`);

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
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };

  const url = `http://${host}:${port}`;
  const deadline = Date.now() + 30000; // 30 second timeout
  let isReady = false;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Quarto Shiny process exited prematurely with code ${child.exitCode}`);
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
    throw new Error(`Quarto Shiny process at ${url} did not respond within 30 seconds`);
  }

  return {
    process: child,
    port,
    url,
    kill,
  };
}
