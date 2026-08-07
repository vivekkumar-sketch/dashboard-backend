"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_ORDER_MARKETPLACES = ["ajio", "nykaa", "nykaa_fashion", "shopify", "myntra"];
const DEFAULT_INVENTORY_MARKETPLACES = ["ajio", "nykaa", "nykaa_fashion"];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

loadEnvFile(path.resolve(__dirname, "..", ".env"));

module.exports = {
  port: Number.parseInt(process.env.PORT || "4010", 10),
  host: process.env.HOST || "0.0.0.0",
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGO_DB || "v1_traffic",
  corsOrigins: parseList(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN, ["*"]),
  orderMarketplaces: parseList(process.env.ORDER_MARKETPLACES, DEFAULT_ORDER_MARKETPLACES),
  inventoryMarketplaces: parseList(process.env.INVENTORY_MARKETPLACES, DEFAULT_INVENTORY_MARKETPLACES),
};
