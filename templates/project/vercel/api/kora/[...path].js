const { timingSafeEqual } = require("node:crypto");

const config = {
  api: {
    bodyParser: false
  }
};

module.exports = async function handler(request, response) {
  try {
    const gatewayToken = process.env.KORA_GATEWAY_TOKEN;
    const upstreamUrl = process.env.KORA_UPSTREAM_URL;
    const upstreamToken = process.env.KORA_UPSTREAM_TOKEN;
    if (!gatewayToken || !upstreamUrl || !upstreamToken) {
      sendJson(response, 500, { error: "Kora gateway is not fully configured" });
      return;
    }
    if (!isAuthorized(request.headers.authorization, gatewayToken)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const upstreamPath = (request.url || "/").replace(/^\/api\/kora(?=\/|$)/, "") || "/";
    const target = `${upstreamUrl.replace(/\/+$/, "")}${upstreamPath}`;
    const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readBody(request);
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${upstreamToken}`,
        "Content-Type": request.headers["content-type"] || "application/json"
      },
      body
    });
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
    response.statusCode = upstreamResponse.status;
    response.setHeader("content-type", upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kora gateway request failed";
    sendJson(response, 502, { error: message });
  }
};

module.exports.config = config;

function isAuthorized(authorization, token) {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const candidate = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1048576) {
      throw new Error("request body exceeds 1 MB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}
