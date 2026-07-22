import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve } from "../../../../src/server.js";

function rawRequest(port, pathname, { method = "GET", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (host !== undefined) requestHeaders.host = host;
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method, headers: requestHeaders },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const scratch = await mkdtemp(path.join(tmpdir(), "lavish-host-guard-evidence-"));
const artifact = path.join(scratch, "private-artifact.html");
await writeFile(artifact, "<!doctype html><h1>private artifact marker</h1>");

const guarded = await serve({
  port: 0,
  stateFile: path.join(scratch, "guarded-state.json"),
  version: "e2e-evidence",
  host: "127.0.0.1",
  linkHost: "127.0.0.1",
  allowedHosts: ["proxy.example"],
});

try {
  const legitimateOpen = await rawRequest(guarded.port, "/api/sessions", {
    method: "POST",
    host: `127.0.0.1:${guarded.port}`,
    body: JSON.stringify({ file: artifact }),
  });
  const { key } = JSON.parse(legitimateOpen.body);
  const forgedHost = `attacker.example:${guarded.port}`;
  const attackBody = JSON.stringify({ prompts: [{ text: "injected attacker prompt" }] });

  const observations = {
    legitimate_loopback_session_open: legitimateOpen.status,
    forged_host_session_open: (
      await rawRequest(guarded.port, "/api/sessions", {
        method: "POST",
        host: forgedHost,
        body: JSON.stringify({ file: artifact }),
      })
    ).status,
    forged_host_rejected_before_malformed_json_parse: (
      await rawRequest(guarded.port, "/api/sessions", {
        method: "POST",
        host: forgedHost,
        body: "{malformed-json",
      })
    ).status,
    forged_host_artifact_read: (
      await rawRequest(guarded.port, `/artifact/${key}/index.html`, { host: forgedHost })
    ).status,
    forged_host_prompt_injection: (
      await rawRequest(guarded.port, `/api/${key}/prompts`, {
        method: "POST",
        host: forgedHost,
        body: attackBody,
      })
    ).status,
    forged_host_agent_poll: (
      await rawRequest(guarded.port, `/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`, {
        host: forgedHost,
      })
    ).status,
    configured_proxy_forwarded_host: (
      await rawRequest(guarded.port, "/health", {
        host: `127.0.0.1:${guarded.port}`,
        headers: { "x-forwarded-host": "proxy.example" },
      })
    ).status,
    unlisted_proxy_forwarded_host: (
      await rawRequest(guarded.port, "/health", {
        host: `127.0.0.1:${guarded.port}`,
        headers: { "x-forwarded-host": "attacker.example" },
      })
    ).status,
    bracketed_ipv6_trailing_garbage: (
      await rawRequest(guarded.port, "/health", { host: "[::1]attacker.example" })
    ).status,
  };

  const legitimatePoll = await rawRequest(
    guarded.port,
    `/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`,
    { host: `127.0.0.1:${guarded.port}` },
  );
  observations.legitimate_poll_after_rejected_injection = JSON.parse(legitimatePoll.body).status;

  console.log(JSON.stringify(observations, null, 2));
} finally {
  await guarded.close();
}

const optedOut = await serve({
  port: 0,
  stateFile: path.join(scratch, "opt-out-state.json"),
  version: "e2e-evidence",
  host: "127.0.0.1",
  linkHost: "127.0.0.1",
  allowedHosts: ["*"],
});

try {
  const response = await rawRequest(optedOut.port, "/health", {
    host: `operator-authenticated.example:${optedOut.port}`,
  });
  console.log(JSON.stringify({ explicit_star_opt_out_foreign_host: response.status }, null, 2));
} finally {
  await optedOut.close();
  await rm(scratch, { recursive: true, force: true });
}
