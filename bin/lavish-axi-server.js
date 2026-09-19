#!/usr/bin/env node
import { installServerStdioTimestamps } from "../src/server-log.js";

installServerStdioTimestamps();
try {
  await import("./lavish-axi.js");
} catch (error) {
  console.error(error);
  process.exit(1);
}
