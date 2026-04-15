import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import { URL } from "node:url";

const TARGET_HOST = process.env.TARGET_HOST || "api.openai.com";
const TARGET_PORT = Number.parseInt(process.env.TARGET_PORT || "443", 10);
const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number.parseInt(process.env.LISTEN_PORT || "19876", 10);
const DEFAULT_UPSTREAM_ORIGIN = process.env.DEFAULT_UPSTREAM_ORIGIN || "https://api.openai.com";
const CERT_PATH = process.env.CERT_PATH;
const KEY_PATH = process.env.KEY_PATH;
const INTERNAL_UPSTREAM_HEADER = "x-openclaw-facade-upstream";
const INTERNAL_PROVIDER_HEADER = "x-openclaw-facade-provider";

if (!CERT_PATH || !KEY_PATH) {
  throw new Error("CERT_PATH and KEY_PATH are required");
}

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function now() {
  return new Date().toISOString();
}

function log(message, extra = {}) {
  const details = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  process.stdout.write(`${now()} ${message}${details}\n`);
}

function stripInternalAndHopHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    if (lower === INTERNAL_UPSTREAM_HEADER || lower === INTERNAL_PROVIDER_HEADER) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function resolveFacadeRoute(req) {
  const provider = typeof req.headers[INTERNAL_PROVIDER_HEADER] === "string" ? req.headers[INTERNAL_PROVIDER_HEADER] : undefined;
  const rawUpstream = typeof req.headers[INTERNAL_UPSTREAM_HEADER] === "string" ? req.headers[INTERNAL_UPSTREAM_HEADER] : DEFAULT_UPSTREAM_ORIGIN;
  let upstreamBase;
  try {
    upstreamBase = new URL(rawUpstream);
  } catch {
    upstreamBase = new URL(DEFAULT_UPSTREAM_ORIGIN);
  }
  return { provider, upstreamBase };
}

function upstreamUrlFromRequest(req) {
  const { upstreamBase } = resolveFacadeRoute(req);
  const parsed = (req.url || "").startsWith("http://") || (req.url || "").startsWith("https://")
    ? new URL(req.url)
    : new URL(req.url || "/", `${upstreamBase.origin}/`);
  return new URL(`${parsed.pathname}${parsed.search}`, upstreamBase);
}

function forwardRequest(req, res, upstreamUrl, hostHeader) {
  const headers = stripInternalAndHopHeaders(req.headers);
  headers.host = hostHeader;

  const transport = upstreamUrl.protocol === "http:" ? http : https;
  const upstreamReq = transport.request(upstreamUrl, {
    method: req.method,
    headers
  }, (upstreamRes) => {
    const responseHeaders = stripInternalAndHopHeaders(upstreamRes.headers);
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (error) => {
    const route = resolveFacadeRoute(req);
    log("upstream request failed", {
      method: req.method,
      url: req.url,
      provider: route.provider ?? null,
      upstream: route.upstreamBase.origin,
      error: error.message
    });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`OpenAI facade upstream error: ${error.message}`);
  });

  req.on("aborted", () => upstreamReq.destroy(new Error("client aborted request")));
  req.pipe(upstreamReq);
}

function proxyFacadeRequest(req, res) {
  const upstreamUrl = upstreamUrlFromRequest(req);
  const route = resolveFacadeRoute(req);
  log("facade request", {
    method: req.method,
    url: req.url,
    provider: route.provider ?? null,
    upstream: route.upstreamBase.origin
  });
  forwardRequest(req, res, upstreamUrl, upstreamUrl.host);
}

function proxyGenericRequest(req, res) {
  let upstreamUrl;
  try {
    upstreamUrl = new URL(req.url || "");
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Proxy request URL must be absolute");
    return;
  }
  log("generic proxy request", {
    method: req.method,
    url: upstreamUrl.toString()
  });
  forwardRequest(req, res, upstreamUrl, upstreamUrl.host);
}

const mitmServer = https.createServer({
  key: fs.readFileSync(KEY_PATH),
  cert: fs.readFileSync(CERT_PATH)
}, (req, res) => {
  proxyFacadeRequest(req, res);
});

mitmServer.on("tlsClientError", (error) => {
  log("tls client error", { error: error.message });
});

const proxyServer = http.createServer((req, res) => {
  if (typeof req.url === "string" && (req.url.startsWith("http://") || req.url.startsWith("https://"))) {
    let parsed;
    try {
      parsed = new URL(req.url);
    } catch {
      parsed = null;
    }
    if (parsed?.hostname === TARGET_HOST) {
      proxyFacadeRequest(req, res);
      return;
    }
  }
  proxyGenericRequest(req, res);
});

proxyServer.on("connect", (req, socket, head) => {
  const [hostPart, portPart] = (req.url || "").split(":", 2);
  const requestedHost = (hostPart || "").trim().toLowerCase();
  const requestedPort = Number.parseInt(portPart || "443", 10);

  if (requestedHost !== TARGET_HOST || requestedPort !== TARGET_PORT) {
    const upstreamSocket = net.connect(requestedPort, requestedHost, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    upstreamSocket.on("error", (error) => {
      log("generic tunnel error", {
        target: req.url,
        error: error.message
      });
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });

    socket.on("error", () => upstreamSocket.destroy());
    log("generic connect tunnel", { target: req.url });
    return;
  }

  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head && head.length > 0) socket.unshift(head);
  mitmServer.emit("connection", socket);
});

proxyServer.on("clientError", (error, socket) => {
  log("proxy client error", { error: error.message });
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function shutdown(signal) {
  log("shutting down", { signal });
  proxyServer.close(() => {
    mitmServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

proxyServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log("openai-compatible facade listening", {
    listen: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
    targetHost: TARGET_HOST,
    defaultUpstream: DEFAULT_UPSTREAM_ORIGIN
  });
});
