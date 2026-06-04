"use strict";

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function matchesOriginPattern(origin, pattern) {
  if (!pattern.includes("*")) {
    return origin === pattern;
  }

  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(origin);
}

function resolveCorsOrigin(req, allowedOrigins = ["*"]) {
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins];
  const normalizedOrigins = origins.map((origin) => String(origin).trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;

  if (!normalizedOrigins.length || normalizedOrigins.includes("*")) {
    return "*";
  }

  if (requestOrigin && normalizedOrigins.some((origin) => matchesOriginPattern(requestOrigin, origin))) {
    return requestOrigin;
  }

  return normalizedOrigins.find((origin) => !origin.includes("*")) || "";
}

function corsHeaders(corsOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
  }

  return headers;
}

function sendJson(res, statusCode, payload, corsOrigin = "*") {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...corsHeaders(corsOrigin),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendOptions(res, corsOrigin = "*") {
  res.writeHead(204, {
    ...corsHeaders(corsOrigin),
  });
  res.end();
}

function parseCsv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function queryParams(searchParams) {
  const params = {};
  for (const [key, value] of searchParams.entries()) {
    params[key] = value;
  }
  return params;
}

module.exports = {
  parseCsv,
  queryParams,
  resolveCorsOrigin,
  sendJson,
  sendOptions,
};
