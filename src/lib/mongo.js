"use strict";

const { MongoClient } = require("mongodb");
const config = require("../config");

let clientPromise;
let didLogConnected = false;

function redactMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      const username = parsed.username ? `${decodeURIComponent(parsed.username)}:<redacted>@` : "";
      return `${parsed.protocol}//${username}${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch (error) {
    return String(uri).replace(/\/\/([^:/?#]+):([^@]+)@/, "//$1:<redacted>@");
  }
}

function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    clientPromise = client.connect()
      .then((connectedClient) => {
        if (!didLogConnected) {
          didLogConnected = true;
          console.log(`MongoDB connected: ${redactMongoUri(config.mongoUri)} db=${config.mongoDb}`);
        }
        return connectedClient;
      })
      .catch((error) => {
        clientPromise = null;
        console.error(`MongoDB connection failed: ${redactMongoUri(config.mongoUri)} db=${config.mongoDb}`);
        console.error(error.message);
        throw error;
      });
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(config.mongoDb);
}

async function pingMongo() {
  const client = await getClient();
  await client.db("admin").command({ ping: 1 });
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
  pingMongo,
};
