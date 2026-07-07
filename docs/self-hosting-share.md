# Self-hosting the share backend

`lavish-axi share` publishes to [ht-ml.app](https://ht-ml.app) by default. Set
`LAVISH_AXI_HTML_APP_API_URL` to point `share` at a backend you control instead.
This page documents the contract that backend must implement.

## Configuration

| Env var | Purpose |
|---|---|
| `LAVISH_AXI_HTML_APP_API_URL` | Base URL of your share backend. Defaults to `https://api.ht-ml.app`; trailing slashes are stripped. |
| `LAVISH_AXI_HTML_APP_TOKEN` | Optional bearer token, sent as `Authorization: Bearer <token>`. Also settable per call with `--token`. |

## Contract

`share` makes a single request:

```
POST {LAVISH_AXI_HTML_APP_API_URL}/v1/sites
Content-Type: application/json
Authorization: Bearer <token>          # only when a token is configured

{
  "html_content": "<full inlined HTML>",
  "password": "<optional>"             # present when --password is used
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
- `site_id`, `status` — optional; surfaced if present.

The request times out after 30 seconds.

## Minimal reference (Cloudflare Worker)

```js
export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || pathname !== "/v1/sites")
      return new Response("Not found", { status: 404 });

    // Require the bearer token — an open endpoint hosts arbitrary HTML on your domain.
    if ((req.headers.get("authorization") || "") !== `Bearer ${env.SHARE_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });

    const { html_content, password } = await req.json();
    const id = crypto.randomUUID().slice(0, 8);
    const updateKey = crypto.randomUUID();
    await env.SITES.put(id, JSON.stringify({ html_content, password: password || null }));

    return Response.json({
      url: `https://${env.VIEW_HOST}/${id}`,
      update_key: updateKey,
      site_id: id,
      status: "published",
    });
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
