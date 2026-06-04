"use strict";

const http = require("http");
const { URL } = require("url");

const config = require("./config");
const { closeMongo, getDb } = require("./lib/mongo");
const { queryParams, resolveCorsOrigin, sendJson, sendOptions } = require("./lib/http");
const {
  getCompanies,
  getComparisonDashboard,
  getIndividualDashboard,
  getMarketplaces,
} = require("./orders/orderService");
const inventoryService = require("./inventory/inventoryService");

async function handleRequest(req, res) {
  const corsOrigin = resolveCorsOrigin(req, config.corsOrigins);

  if (req.method === "OPTIONS") {
    sendOptions(res, corsOrigin);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" }, corsOrigin);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const query = queryParams(url.searchParams);

  try {
    if (url.pathname === "/api/health") {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: "v1-traffic-backend",
          mongoDb: config.mongoDb,
        },
        corsOrigin
      );
      return;
    }

    const db = await getDb();

    if (url.pathname === "/api/orders/marketplaces") {
      sendJson(res, 200, { marketplaces: await getMarketplaces(db) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/orders/companies") {
      sendJson(res, 200, { companies: await getCompanies(db, query) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/orders/individual") {
      sendJson(res, 200, await getIndividualDashboard(db, query), corsOrigin);
      return;
    }

    if (url.pathname === "/api/orders/comparison") {
      sendJson(res, 200, await getComparisonDashboard(db, query), corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/marketplaces") {
      sendJson(res, 200, { marketplaces: await inventoryService.getMarketplaces(db) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/companies") {
      sendJson(res, 200, { companies: await inventoryService.getCompanies(db, query) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/event-types") {
      sendJson(res, 200, { eventTypes: await inventoryService.getEventTypes(db, query) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/workers") {
      sendJson(res, 200, { workers: await inventoryService.getWorkers(db, query) }, corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/individual") {
      sendJson(res, 200, await inventoryService.getIndividualDashboard(db, query), corsOrigin);
      return;
    }

    if (url.pathname === "/api/inventory/comparison") {
      sendJson(res, 200, await inventoryService.getComparisonDashboard(db, query), corsOrigin);
      return;
    }

    sendJson(res, 404, { error: "Not found" }, corsOrigin);
  } catch (error) {
    const statusCode = /required|invalid/i.test(error.message) ? 400 : 500;
    sendJson(
      res,
      statusCode,
      {
        error: error.message,
      },
      corsOrigin
    );
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(config.port, config.host, () => {
  console.log(`v1-traffic backend listening on http://${config.host}:${config.port}`);
});

async function shutdown() {
  console.log("Shutting down v1-traffic backend...");
  server.close(async () => {
    await closeMongo();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
