#!/usr/bin/env node
import { installServerStdioTimestamps } from "../src/server-log.js";

installServerStdioTimestamps();
let run;
try {
  ({ run } = await import("../src/cli.js"));
} catch (error) {
  console.error(error);
  process.exit(1);
}
await run(process.argv.slice(2));
