import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import express from "express";
import { findFreePort } from "../src/shiny-process.js";
import { createShinyProxy, proxyWebSocket } from "../src/shiny-proxy.js";

test("shiny-proxy HTTP proxying and SDK injection", async () => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();

  const sockets = new Set();

  // 1. Create Mock Shiny Backend
  const backend = http.createServer((req, res) => {
    if (req.url === "/index.html") {
      const htmlContent = "<html><body><h1>Shiny Mock</h1></body></html>";
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(Buffer.byteLength(htmlContent)),
        "X-Frame-Options": "SAMEORIGIN",
        "Content-Security-Policy": "default-src 'self'",
        Location: "/index.html", // testing Location header rewrite
      });
      res.end(htmlContent);
    } else if (req.url === "/plain") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("plain text");
    } else if (req.url === "/redirect") {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${backendPort}/index.html`,
      });
      res.end();
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  backend.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => backend.listen(backendPort, "127.0.0.1", () => resolve()));

  // 2. Create Express Proxy Server
  const app = express();
  const sessionKey = "test-session-123";
  app.use(`/shiny/${sessionKey}`, createShinyProxy(`http://127.0.0.1:${backendPort}`, sessionKey));

  const proxyServer = http.createServer(app);
  proxyServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxyServer.listen(proxyPort, "127.0.0.1", () => resolve()));

  try {
    // A. Verify HTML request is proxied, SDK is injected, and frame headers/content-length are stripped
    const htmlRes = await fetch(`http://127.0.0.1:${proxyPort}/shiny/${sessionKey}/index.html`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("x-frame-options"), null);
    assert.equal(htmlRes.headers.get("content-security-policy"), null);
    assert.equal(htmlRes.headers.get("content-length"), null);

    const htmlText = await htmlRes.text();
    assert.match(htmlText, /Shiny Mock/);
    assert.match(htmlText, /<script src="\/sdk\.js\?key=test-session-123"><\/script><\/body>/);

    // B. Verify non-HTML request is proxied unchanged
    const plainRes = await fetch(`http://127.0.0.1:${proxyPort}/shiny/${sessionKey}/plain`, {
      headers: { Connection: "close" },
    });
    assert.equal(plainRes.status, 200);
    const plainText = await plainRes.text();
    assert.equal(plainText, "plain text");

    // C. Verify Redirect / Location rewrite
    const redirectRes = await fetch(`http://127.0.0.1:${proxyPort}/shiny/${sessionKey}/redirect`, {
      redirect: "manual",
      headers: { Connection: "close" },
    });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), `/shiny/${sessionKey}/index.html`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    backend.close();
    proxyServer.close();
  }
});

test("shiny-proxy WebSocket proxying", async () => {
  const backendPort = await findFreePort();
  const proxyPort = await findFreePort();
  const sessionKey = "test-session-ws";

  const sockets = new Set();

  // 1. Mock Shiny WebSocket Backend
  const backend = http.createServer();
  backend.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  backend.on("upgrade", (_req, socket, _head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" + "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" + "\r\n",
    );

    socket.on("data", (data) => {
      socket.write(`echo:${data.toString()}`);
    });
  });

  await new Promise((resolve) => backend.listen(backendPort, "127.0.0.1", () => resolve()));

  // 2. Create Proxy Server with WebSocket upgrade routing
  const proxyServer = http.createServer();
  proxyServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxyServer.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith(`/shiny/${sessionKey}`)) {
      proxyWebSocket(req, socket, head, `http://127.0.0.1:${backendPort}`);
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve) => proxyServer.listen(proxyPort, "127.0.0.1", () => resolve()));

  try {
    // 3. Connect to proxy WebSocket and test message echo
    const socket = net.connect(proxyPort, "127.0.0.1");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));

    // Handshake
    socket.write(
      `GET /shiny/${sessionKey}/websocket/ HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${proxyPort}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n",
    );

    const dataPromise = new Promise((resolve) => {
      socket.on("data", (data) => {
        resolve(data.toString());
      });
    });

    const response = await dataPromise;
    assert.match(response, /101 Switching Protocols/);

    // Send payload
    socket.write("hello websocket");

    const echoPromise = new Promise((resolve) => {
      socket.once("data", (data) => {
        resolve(data.toString());
      });
    });

    const echoResponse = await echoPromise;
    assert.equal(echoResponse, "echo:hello websocket");

    socket.destroy();
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    backend.close();
    proxyServer.close();
  }
});
