import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
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
