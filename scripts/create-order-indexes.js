#!/usr/bin/env node

"use strict";

const { getDb, closeMongo } = require("../src/lib/mongo");
const { ensureOrderIndexes } = require("../src/orders/indexes");

async function main() {
  const db = await getDb();
  const results = await ensureOrderIndexes(db);

  for (const result of results) {
    console.log(`${result.collection}: ${result.indexes.join(", ")}`);
  }
  console.log(`Indexed ${results.length} order collections.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
  });
