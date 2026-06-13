import http from "node:http";
import net from "node:net";
import { injectLavishSdk } from "./html-transform.js";

/**
 * Creates an Express middleware that proxies requests to a Shiny app.
 * @param {string} shinyUrl The base URL of the running Shiny app (e.g., http://127.0.0.1:port)
 * @param {string} sessionKey The session key
 * @returns {import("express").RequestHandler}
 */
export function createShinyProxy(shinyUrl, sessionKey) {
  const targetUrl = new URL(shinyUrl);

  return (req, res, next) => {
    // req.url contains the path relative to the mount point (e.g. / or /shared/shiny.js) plus search query.
    // If it's empty or doesn't start with /, force it to start with /
    let targetPath = req.url;
    if (!targetPath.startsWith("/")) {
      targetPath = "/" + targetPath;
    }

    const options = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: targetPath,
      headers: {
        ...req.headers,
        host: `${targetUrl.hostname}:${targetUrl.port}`,
      },
    };

    // Remove headers that might interfere with proxying or cause local connection issues
    delete options.headers["connection"];
    delete options.headers["upgrade"];
    delete options.headers["accept-encoding"];

    const proxyReq = http.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };

      // Strip security/frame headers to allow embedding in iframe
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];

      // Rewrite Location header for redirects so they stay in the proxy path
      const location = headers["location"];
      if (location) {
        if (location.startsWith("/")) {
          headers["location"] = `/shiny/${sessionKey}${location}`;
        } else if (location.startsWith(targetUrl.origin)) {
          headers["location"] = location.replace(targetUrl.origin, `/shiny/${sessionKey}`);
        }
      }

      const contentType = headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      if (isHtml) {
        delete headers["content-length"];
      }

      // Set rewritten headers
      res.writeHead(proxyRes.statusCode || 200, headers);

      if (isHtml) {
        // Buffer response to inject the SDK
        let body = Buffer.alloc(0);
        proxyRes.on("data", (chunk) => {
          body = Buffer.concat([body, chunk]);
        });
        proxyRes.on("end", () => {
          const html = body.toString("utf8");
          const modifiedHtml = injectLavishSdk(html, sessionKey);
          res.end(modifiedHtml);
        });
      } else {
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      // If client closed request early, ignore error
      if (req.destroyed) return;
      next(err);
    });

    req.pipe(proxyReq);
  };
}

/**
 * Handles HTTP Upgrade requests to proxy WebSockets to the Shiny app.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 * @param {string} shinyUrl The base URL of the running Shiny app
 */
export function proxyWebSocket(req, socket, head, shinyUrl) {
  const targetUrl = new URL(shinyUrl);
  const targetPort = Number(targetUrl.port);
  const targetHost = targetUrl.hostname;

  // The request URL is the full path on our server, e.g. /shiny/:key/websocket/
  // We need to strip the prefix to forward it to the Shiny backend.
  const url = new URL(req.url || "", "http://localhost");
  const targetPath = url.pathname.replace(/^\/shiny\/[^/]+/, "") + url.search;

  const targetSocket = net.connect(targetPort, targetHost, () => {
    // Write HTTP Upgrade request to the Shiny backend
    targetSocket.write(`${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n`);
    for (const [key, val] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") {
        targetSocket.write(`Host: ${targetHost}:${targetPort}\r\n`);
      } else {
        targetSocket.write(`${key}: ${val}\r\n`);
      }
    }
    targetSocket.write("\r\n");

    // Forward any head data we've already received
    if (head && head.length > 0) {
      targetSocket.write(head);
    }

    // Pipe the sockets together
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    targetSocket.destroy();
  });
}
