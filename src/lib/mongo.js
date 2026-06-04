"use strict";

const { MongoClient } = require("mongodb");
const config = require("../config");

let clientPromise;

function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(config.mongoDb);
}

async function closeMongo() {
  if (!clientPromise) {
    return;
  }
  const client = await clientPromise;
  await client.close();
  clientPromise = null;
}

module.exports = {
  closeMongo,
  getDb,
};
