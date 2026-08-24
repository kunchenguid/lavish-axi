import assert from "node:assert/strict";
import test from "node:test";

import {
  createHtmlAppPayload,
  createHtmlAppUpdatePayload,
  createUnpublishedPageHtml,
  hostRejectedShareWrite,
  htmlAppApiUrl,
  normalizeSiteId,
  publishedDespiteError,
  publishToHtmlApp,
  updateHtmlApp,
} from "../src/html-app.js";

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

test("publishToHtmlApp reports an incomplete 200 as published, keeping the fields that did arrive", async () => {
  // A 200 means the page landed. The caller must be able to tell that from a transport failure,
  // and must be handed whatever came back - a url with no update_key is a live, public-by-default
  // page whose only write credential is gone for good.
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", url: "https://abc.ht-ml.app/" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /response did not include an update_key/);
      const received = publishedDespiteError(error);
      assert.ok(received, "an incomplete 200 must be distinguishable from a lost response");
      assert.equal(received.url, "https://abc.ht-ml.app/");
      assert.equal(received.siteId, "abc");
      assert.equal(received.updateKey, undefined);
      return true;
    },
  );
});

test("publishToHtmlApp reports an incomplete 200 that omits the url", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc", update_key: "uk" }));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /response did not include a url/);
      const received = publishedDespiteError(error);
      assert.ok(received);
      assert.equal(received.updateKey, "uk", "a surviving update_key still makes the page changeable");
      assert.equal(received.url, undefined);
      return true;
    },
  );
});

test("a transport failure is not reported as published", async () => {
  const fetchImpl = () => Promise.reject(new Error("socket hang up"));

  await assert.rejects(
    () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
    (error) => {
      assert.equal(publishedDespiteError(error), null, "a lost response proves nothing landed");
      assert.equal(hostRejectedShareWrite(error), false, "and it is not a host rejection either");
      return true;
    },
  );
});

test("hostRejectedShareWrite separates an answered rejection from an unknown outcome", async () => {
  for (const [status, rejected] of [
    [400, true],
    [404, true],
    [422, true],
    [500, false],
    [503, false],
  ]) {
    const { fetchImpl } = recordingFetch(jsonResponse(status, {}));
    await assert.rejects(
      () => publishToHtmlApp("<h1>Hi</h1>", { fetch: fetchImpl, env: {} }),
      (error) => {
        assert.equal(hostRejectedShareWrite(error), rejected, `status ${status}`);
        return true;
      },
    );
  }
});

test("a site_id the host echoes cannot smuggle flags into what Lavish reports", async () => {
  // The echoed id reaches a backticked republish command an agent may run, so `abc123 --password
  // evil` must not survive. It is a path segment; anything normalizeSiteId refuses is not one.
  const { fetchImpl } = recordingFetch(jsonResponse(200, { site_id: "abc123 --password evil", url: "https://x/" }));
  const updated = await updateHtmlApp("abc123", "<h1>Hi</h1>", {
    fetch: fetchImpl,
    env: {},
    updateKey: "uk",
  });

  assert.equal(updated.site_id, "abc123", "the locally validated id wins over a malformed echo");

  const { fetchImpl: goodFetch } = recordingFetch(jsonResponse(200, { site_id: "renamed", url: "https://x/" }));
  const renamed = await updateHtmlApp("abc123", "<h1>Hi</h1>", { fetch: goodFetch, env: {}, updateKey: "uk" });
  assert.equal(renamed.site_id, "renamed", "a well-formed echo is still honored");
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

test("normalizeSiteId accepts an id and explains that a URL is not one", () => {
  assert.equal(normalizeSiteId(" abc123 "), "abc123");
  assert.throws(() => normalizeSiteId("https://abc123.ht-ml.app/"), /site_id/);
  assert.throws(() => normalizeSiteId("abc/../123"), /site_id/);
  assert.throws(() => normalizeSiteId(""), /site_id/);
});

test("normalizeSiteId refuses a dot segment that would resolve away from the site path", () => {
  // `..` survives encodeURIComponent, so /v1/sites/.. would collapse to the collection root and
  // PUT the artifact there instead of at a site.
  assert.throws(() => normalizeSiteId("."), /not a valid site_id/);
  assert.throws(() => normalizeSiteId(".."), /not a valid site_id/);
  assert.throws(() => normalizeSiteId(" .. "), /not a valid site_id/);
  assert.throws(() => normalizeSiteId("..."), /not a valid site_id/);
  assert.equal(normalizeSiteId("..abc"), "..abc");
});

test("updateHtmlApp never PUTs to a path a dot segment resolves away from the site", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, {}));

  await assert.rejects(
    () =>
      updateHtmlApp("..", "<h1>Hi</h1>", { updateKey: "uk", apiUrl: "https://api.example", fetch: fetchImpl, env: {} }),
    /not a valid site_id/,
  );
  assert.equal(calls.length, 0);
});

test("createHtmlAppUpdatePayload omits the password to preserve it and sends one to rotate it", () => {
  assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>"), { html_content: "<h1>Hi</h1>" });
  assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>", { password: "secret" }), {
    html_content: "<h1>Hi</h1>",
    password: "secret",
  });
});

test("createHtmlAppUpdatePayload never sends an empty password the host accepts and ignores", () => {
  // Probed live: PUT with password "" answers 200 and leaves the original password working, so
  // sending one would make Lavish report a page as public while it is still gated.
  for (const password of ["", "   ", null, undefined]) {
    assert.deepEqual(createHtmlAppUpdatePayload("<h1>Hi</h1>", { password }), { html_content: "<h1>Hi</h1>" });
  }
});

test("updateHtmlApp omits the password from the wire body on a plain republish", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, { url: "https://x.example/", site_id: "abc123" }));

  await updateHtmlApp("abc123", "<h1>Newer</h1>", {
    updateKey: "uk",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.deepEqual(JSON.parse(calls[0].init.body), { html_content: "<h1>Newer</h1>" });
});

test("updateHtmlApp replaces the site HTML with the update key as the bearer credential", async () => {
  const { fetchImpl, calls } = recordingFetch(
    jsonResponse(200, { site_id: "abc123", url: "https://abc123.ht-ml.app/", status: "active" }),
  );

  const result = await updateHtmlApp("abc123", "<h1>Newer</h1>", {
    updateKey: "uk_secret",
    password: "hunter2",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/sites/abc123");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers.authorization, "Bearer uk_secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), { html_content: "<h1>Newer</h1>", password: "hunter2" });
  assert.deepEqual(result, { url: "https://abc123.ht-ml.app/", site_id: "abc123", status: "active" });
});

test("updateHtmlApp falls back to the known site url when the response omits one", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, {}));

  const result = await updateHtmlApp("abc123", "<h1>Hi</h1>", {
    updateKey: "uk",
    url: "https://plans.example.com/abc123",
    apiUrl: "https://api.example",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(result.url, "https://plans.example.com/abc123");
  assert.equal(result.site_id, "abc123");
});

test("updateHtmlApp reports no url rather than guessing one the backend never published", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(200, {}));

  const result = await updateHtmlApp("abc123", "<h1>Hi</h1>", {
    updateKey: "uk",
    apiUrl: "https://share.example.com",
    fetch: fetchImpl,
    env: {},
  });

  assert.equal(result.url, "", "a self-hosted backend's pages do not live on ht-ml.app");
  assert.equal(result.site_id, "abc123");
});

test("updateHtmlApp requires an update key", async () => {
  const { fetchImpl, calls } = recordingFetch(jsonResponse(200, {}));

  await assert.rejects(() => updateHtmlApp("abc123", "<h1>Hi</h1>", { fetch: fetchImpl, env: {} }), /update_key/);
  assert.equal(calls.length, 0);
});

test("updateHtmlApp explains a rejected update key", async () => {
  const { fetchImpl } = recordingFetch(jsonResponse(401, {}));

  await assert.rejects(
    () => updateHtmlApp("abc123", "<h1>Hi</h1>", { updateKey: "wrong", fetch: fetchImpl, env: {} }),
    /unauthorized/,
  );
});

test("the unpublished placeholder is a self-contained page that says the content is gone", () => {
  const html = createUnpublishedPageHtml();

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /unpublished/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});
