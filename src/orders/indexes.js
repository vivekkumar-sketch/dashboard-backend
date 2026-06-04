"use strict";

const { listOrderCollections, orderCollectionName } = require("./orderService");

const ORDER_INDEXES = [
  { key: { date: 1 }, name: "order_date_idx" },
  { key: { timestamp_utc: 1 }, name: "order_timestamp_utc_idx" },
  { key: { marketplace_key: 1, date: 1 }, name: "order_marketplace_date_idx" },
  { key: { company_id: 1, date: 1 }, name: "order_company_date_idx" },
  { key: { order_no: 1 }, name: "order_no_idx" },
  { key: { event_type: 1, date: 1 }, name: "order_event_type_date_idx" },
  { key: { backup_hash: 1 }, name: "backup_hash_1", unique: true },
];

async function ensureOrderIndexes(db) {
  const marketplaceKeys = await listOrderCollections(db);
  const results = [];

  for (const marketplaceKey of marketplaceKeys) {
    const collectionName = orderCollectionName(marketplaceKey);
    const collection = db.collection(collectionName);

    for (const index of ORDER_INDEXES) {
      await collection.createIndex(index.key, {
        name: index.name,
        unique: Boolean(index.unique),
        background: true,
      });
    }

    results.push({
      marketplace: marketplaceKey,
      collection: collectionName,
      indexes: ORDER_INDEXES.map((index) => index.name),
    });
  }

  return results;
}

module.exports = {
  ORDER_INDEXES,
  ensureOrderIndexes,
};
