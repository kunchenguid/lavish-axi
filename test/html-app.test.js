import assert from "node:assert/strict";
import test from "node:test";

import { createHtmlAppPayload, htmlAppApiUrl, publishToHtmlApp } from "../src/html-app.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

test("createHtmlAppPayload sends html_content and only adds a password when provided", () => {
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>"), { html_content: "<h1>Hi</h1>" });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "  secret " }), {
    html_content: "<h1>Hi</h1>",
    password: "secret",
  });
  assert.deepEqual(createHtmlAppPayload("<h1>Hi</h1>", { password: "   " }), { html_content: "<h1>Hi</h1>" });
});

test("htmlAppApiUrl defaults to ht-ml.app and honors the override env", () => {
  assert.equal(htmlAppApiUrl({}), "https://api.ht-ml.app");
  assert.equal(htmlAppApiUrl({ LAVISH_AXI_HTML_APP_API_URL: "http://127.0.0.1:9/" }), "http://127.0.0.1:9");
});

test("publishToHtmlApp posts the HTML to /v1/sites and returns the public url and update key", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse(200, {
      site_id: "abc123",
      url: "https://abc123.ht-ml.app/",
      update_key: "uk_secret",
      status: "active",
    }),
  );

  const result = await publishToHtmlApp("<h1>Ship me</h1>", {
    password: "hunter2",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/sites");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { html_content: "<h1>Ship me</h1>", password: "hunter2" });
  assert.deepEqual(result, {
    url: "https://abc123.ht-ml.app/",
    site_id: "abc123",
    update_key: "uk_secret",
    status: "active",
  });
});

test("publishToHtmlApp sends a bearer token when one is configured", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, { url: "https://x.ht-ml.app/", update_key: "uk" }));

  await publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: { LAVISH_AXI_HTML_APP_TOKEN: "tok_123" } });

  assert.equal(calls[0].init.headers.authorization, "Bearer tok_123");
});

test("publishToHtmlApp rejects a successful response that omits the url", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", update_key: "uk" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    /response did not include a url/,
  );
});

test("publishToHtmlApp rejects a successful response that omits the update key", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", url: "https://abc.ht-ml.app/" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    /response did not include an update_key/,
  );
});

test("publishToHtmlApp explains a failed content safety scan", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(422, {}));

  await assert.rejects(
    () => publishToHtmlApp("<script>evil()</script>", { fetch: fetchImpl, env: {} }),
    /content safety scan/,
  );
});

test("publishToHtmlApp surfaces an error detail returned by the API", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(400, { detail: "html_content is required" }));

  await assert.rejects(() => publishToHtmlApp("", { fetch: fetchImpl, env: {} }), /html_content is required/);
});

test("publishToHtmlApp keeps the timeout active while reading the response body", async () => {
  let textStarted = false;
  /** @type {any} */
  const fetchImpl = async (_url, init) => ({
    ok: true,
    status: 200,
    text: async () => {
      textStarted = true;
      await new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init.signal.aborted) {
          abort();
          return;
        }
        init.signal.addEventListener("abort", abort, { once: true });
      });
      return "";
    },
  });

  await assert.rejects(() => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {}, timeoutMs: 1 }), /timed out/);
  assert.equal(textStarted, true);
});
