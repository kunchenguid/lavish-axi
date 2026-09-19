/**
 * Stamp a server log line with a UTC timestamp. server.log is append-only across restarts, so an
 * undated line cannot be correlated with an outage after the fact.
 * @param {string} line
 * @param {Date} [now]
 * @returns {string}
 */
export function formatServerLogLine(line, now = new Date()) {
  return `${now.toISOString()} ${line}`;
}

const STDIO_STAMPED = Symbol.for("lavish-axi.stdio-timestamped");

export function serverStdioIsTimestamped() {
  return Boolean(globalThis[STDIO_STAMPED]);
}

export function createTimestampedWrite(write, now = () => new Date()) {
  let atLineStart = true;
  return function timestampedWrite(chunk, encoding, callback) {
    let enc = encoding;
    let cb = callback;
    if (typeof encoding === "function") {
      cb = encoding;
      enc = undefined;
    }
    const str = chunkToString(chunk, enc);
    let out = "";
    for (let i = 0; i < str.length; i += 1) {
      if (atLineStart) {
        out += formatServerLogLine("", now());
        atLineStart = false;
      }
      const ch = str[i];
      out += ch;
      if (ch === "\n") atLineStart = true;
    }
    return write(out, enc, cb);
  };
}

export function installServerStdioTimestamps(now = () => new Date()) {
  if (serverStdioIsTimestamped()) return;
  globalThis[STDIO_STAMPED] = true;
  process.stdout.write = createTimestampedWrite(process.stdout.write.bind(process.stdout), now);
  process.stderr.write = createTimestampedWrite(process.stderr.write.bind(process.stderr), now);
}

function chunkToString(chunk, encoding) {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString(typeof encoding === "string" ? encoding : "utf8");
  return String(chunk);
}
