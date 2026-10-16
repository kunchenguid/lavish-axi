#!/usr/bin/env node
import { installServerStdioTimestamps } from "../src/server-log.js";

installServerStdioTimestamps();
let fatalExitScheduled = false;
function handleFatalServerError(kind, error) {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[lavish] ${kind}: ${detail}`);
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  process.exitCode = 1;
  // Let stderr flush before terminating. An uncaught exception handler prevents Node's default
  // exit, so explicitly end the process rather than leaving a possibly corrupted server alive.
  setImmediate(() => process.exit(1));
}

process.on("uncaughtException", (error) => handleFatalServerError("uncaught exception", error));

try {
  await import("./lavish-axi.js");
} catch (error) {
  handleFatalServerError("server startup failed", error);
}
