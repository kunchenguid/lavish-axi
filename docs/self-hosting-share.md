# Self-hosting the share backend

`lavish-axi share` publishes to [ht-ml.app](https://ht-ml.app) by default. Set
`LAVISH_AXI_HTML_APP_API_URL` to point `share` at a backend you control instead.
This page documents the contract that backend must implement.

## Configuration

| Env var                       | Purpose                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAVISH_AXI_HTML_APP_API_URL` | Base URL of your share backend. Defaults to `https://api.ht-ml.app`; trailing slashes are stripped.                                                                                                                          |
| `LAVISH_AXI_HTML_APP_TOKEN`   | Optional bearer token for `POST /v1/sites` only, sent as `Authorization: Bearer <token>`. Also settable per call with `--token`. Republishes authorize with the page's `update_key` instead, so `--token` is rejected there. |

## Contract

`share` creates a page with one request, and republishes an existing one with a second:

```
POST {LAVISH_AXI_HTML_APP_API_URL}/v1/sites
Content-Type: application/json
Authorization: Bearer <token>          # only when a token is configured

{
  "html_content": "<full inlined HTML>",
  "password": "<optional>"             # present when --password or --private is used
}
```

The response must be JSON containing at least `url` and `update_key` — `share`
errors if either is missing:

```json
{
  "url": "https://plans.example.com/abc123",
  "update_key": "<secret, shown once>",
  "site_id": "abc123",
  "status": "published"
}
```

- `url` — where the published artifact is viewable. Your backend owns this; it can be any URL on your domain.
- `update_key` — an opaque secret returned to the user for managing the page later.
- `site_id` — optional, but it is what the user passes back as `--site` to republish or unpublish, so a backend that omits it supports creation only. It is interpolated into the `PUT` path, so `share` accepts only `A-Za-z0-9._-` and refuses an all-dots id; pick ids from that set.
- `status` — optional; surfaced if present.

### Republishing

`share --site <site_id> --update-key <key>` (and `--unpublish`, which sends a placeholder page)
replaces an existing page in place:

```
PUT {LAVISH_AXI_HTML_APP_API_URL}/v1/sites/{site_id}
Content-Type: application/json
Authorization: Bearer <update_key>

{
  "html_content": "<full inlined HTML>",
  "password": "<optional>"             # absent on a plain republish; present to set or rotate one
}
```

There is no way to remove a page's password. Lavish never sends an empty `password`, and offers no
flag that would: ht-ml.app answers `200` to a clear and leaves the page gated, so a backend that
implements one cannot be told apart from one that does not, and the CLI would report a page as
public while it is still private.

`Authorization` on this request carries the `update_key`, not the create-time bearer token, so a
backend that gates `POST /v1/sites` with a shared token has to authorize `PUT` by the stored
`update_key` alone. `--token` is rejected on a republish rather than silently dropped, because the
header has no room for both.

The response may repeat `url`, `site_id`, and `status`. Return `url`: when the body omits one,
`share` reports the republish without a URL rather than guessing a host, since the API base is
yours. Reject the request with `401` when the `update_key` does not match: that key is the page's
only credential, so treating a bad one as a no-op silently loses the update.

`share` never issues a `DELETE`. ht-ml.app has no delete endpoint, and `--unpublish` is a `PUT` of a
placeholder page behind a fresh password, so a backend implementing this contract needs no delete
route either.

Both requests time out after 30 seconds.

## Minimal reference (Cloudflare Worker)

```js
export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer /, "");

    if (req.method === "POST" && pathname === "/v1/sites") {
      // Require the bearer token — an open endpoint hosts arbitrary HTML on your domain.
      if (bearer !== env.SHARE_TOKEN) return new Response("Unauthorized", { status: 401 });

      const { html_content, password } = await req.json();
      const id = crypto.randomUUID().slice(0, 8);
      const update_key = crypto.randomUUID();
      await env.SITES.put(id, JSON.stringify({ html_content, password: password || null, update_key }));

      return Response.json({
        url: `https://${env.VIEW_HOST}/${id}`,
        update_key,
        site_id: id,
        status: "published",
      });
    }

    const site = pathname.startsWith("/v1/sites/") && pathname.slice("/v1/sites/".length);
    if (req.method === "PUT" && site && !site.includes("/")) {
      const stored = await env.SITES.get(site, "json");
      // The update_key is the page's only credential — a mismatch must fail, never no-op.
      if (!stored || bearer !== stored.update_key) return new Response("Unauthorized", { status: 401 });

      const { html_content, password } = await req.json();
      // An absent password preserves the stored one; a present one sets or rotates it.
      await env.SITES.put(site, JSON.stringify({ ...stored, html_content, password: password || stored.password }));

      return Response.json({ url: `https://${env.VIEW_HOST}/${site}`, site_id: site, status: "published" });
    }

    return new Response("Not found", { status: 404 });
  },
};
```

Serve the viewer (`GET /:id`) from a **separate origin** so untrusted artifact
JavaScript never runs on your app's origin, and enforce the stored `password`
before returning the HTML.

## Security notes

- **Gate publish with a token.** An unauthenticated `/v1/sites` lets anyone host arbitrary HTML on your domain — a phishing and malware vector wearing your name.
- **Isolate the viewer origin.** Published artifacts run their own JavaScript; serve them from a dedicated host with a restrictive CSP so a script in one artifact can't reach your app's cookies or session.
- **Honor `password`.** When present, require it before serving the artifact.
