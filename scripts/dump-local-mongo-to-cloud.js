#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const DEFAULT_SOURCE_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB_NAME = "v1_traffic";
const DEFAULT_BATCH_SIZE = 1000;

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

loadEnvFile(path.resolve(__dirname, "..", ".env"));

function parseCsv(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    sourceUri: process.env.SOURCE_MONGO_URI || process.env.LOCAL_MONGO_URI || DEFAULT_SOURCE_URI,
    sourceDb: process.env.SOURCE_MONGO_DB || process.env.LOCAL_MONGO_DB || process.env.MONGO_DB || DEFAULT_DB_NAME,
    targetUri: process.env.TARGET_MONGO_URI || process.env.MONGO_URI || "",
    targetDb: process.env.TARGET_MONGO_DB || process.env.MONGO_DB || DEFAULT_DB_NAME,
    collections: [],
    batchSize: DEFAULT_BATCH_SIZE,
    copyIndexes: true,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--source-uri") {
      args.sourceUri = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--source-db") {
      args.sourceDb = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--target-uri") {
      args.targetUri = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--target-db") {
      args.targetDb = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--collection") {
      args.collections.push(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--collections") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        args.collections.push(...parseCsv(argv[index + 1]));
        index += 1;
      }
    } else if (arg === "--batch-size") {
      args.batchSize = Number.parseInt(requiredValue(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--skip-indexes") {
      args.copyIndexes = false;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.collections = Array.from(new Set(args.collections.map((name) => String(name).trim()).filter(Boolean)));

  if (args.help) {
    return args;
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }

  if (!args.targetUri) {
    throw new Error("Target Mongo URI is required. Set MONGO_URI in backend/.env or pass --target-uri.");
  }

  if (args.sourceUri === args.targetUri && args.sourceDb === args.targetDb) {
    throw new Error("Source and target MongoDB are the same. Refusing to run.");
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/dump-local-mongo-to-cloud.js",
    "  node scripts/dump-local-mongo-to-cloud.js --source-uri mongodb://127.0.0.1:27017 --target-uri mongodb+srv://...",
    "",
    "Options:",
    "  --source-uri <uri>        Local Mongo URI. Default: LOCAL_MONGO_URI or mongodb://127.0.0.1:27017",
    "  --source-db <name>        Local DB name. Default: LOCAL_MONGO_DB or MONGO_DB or v1_traffic",
    "  --target-uri <uri>        Cloud Mongo URI. Default: TARGET_MONGO_URI or MONGO_URI",
    "  --target-db <name>        Cloud DB name. Default: TARGET_MONGO_DB or MONGO_DB or v1_traffic",
    "  --collection <name>       Copy one collection. Can be repeated.",
    "  --collections <names...>  Copy specific collections; comma separated names are allowed.",
    "  --batch-size <number>     Default: 1000",
    "  --skip-indexes            Do not copy non-_id indexes before inserting data.",
    "  --dry-run                 Count documents only; cloud MongoDB is not changed.",
  ].join("\n");
}

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

async function listCollectionNames(db, requestedCollections) {
  if (requestedCollections.length) {
    return requestedCollections;
  }

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  return collections
    .map((collection) => collection.name)
    .filter((name) => !name.startsWith("system."));
}

function duplicateFilter(document) {
  const filters = [{ _id: document._id }];

  if (document.backup_hash) {
    filters.push({ backup_hash: document.backup_hash });
  }
  if (document.inventory_key) {
    filters.push({ inventory_key: document.inventory_key });
  }

  return filters.length === 1 ? filters[0] : { $or: filters };
}

async function copyIndexes(sourceCollection, targetCollection) {
  const indexes = await sourceCollection.indexes();
  let copied = 0;

  for (const index of indexes) {
    if (index.name === "_id_") {
      continue;
    }

    const { key, name, ns, v, ...options } = index;
    try {
      await targetCollection.createIndex(key, { ...options, name });
      copied += 1;
    } catch (error) {
      console.warn(`Index skipped on ${targetCollection.collectionName}.${name}: ${error.message}`);
    }
  }

  return copied;
}

async function flushBatch(targetCollection, batch) {
  if (!batch.length) {
    return { inserted: 0, skipped: 0 };
  }

  const operations = batch.map((document) => ({
    updateOne: {
      filter: duplicateFilter(document),
      update: { $setOnInsert: document },
      upsert: true,
    },
  }));

  const result = await targetCollection.bulkWrite(operations, { ordered: false });
  return {
    inserted: result.upsertedCount || 0,
    skipped: result.matchedCount || 0,
  };
}

async function copyCollection(sourceDb, targetDb, collectionName, args) {
  const sourceCollection = sourceDb.collection(collectionName);
  const targetCollection = targetDb.collection(collectionName);
  const total = await sourceCollection.countDocuments();

  if (args.dryRun) {
    return { collectionName, total, inserted: 0, skipped: 0, indexes: 0 };
  }

  const indexes = args.copyIndexes ? await copyIndexes(sourceCollection, targetCollection) : 0;
  const cursor = sourceCollection.find({}, { batchSize: args.batchSize });
  let batch = [];
  let inserted = 0;
  let skipped = 0;

  for await (const document of cursor) {
    batch.push(document);
    if (batch.length >= args.batchSize) {
      const result = await flushBatch(targetCollection, batch);
      inserted += result.inserted;
      skipped += result.skipped;
      batch = [];
    }
  }

  const result = await flushBatch(targetCollection, batch);
  inserted += result.inserted;
  skipped += result.skipped;

  return { collectionName, total, inserted, skipped, indexes };
}

async function connectMongo(label, client, uri, dbName) {
  console.log(`Connecting to ${label} MongoDB...`);
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(`${label} MongoDB connected: ${redactMongoUri(uri)} db=${dbName}`);
  } catch (error) {
    console.error(`${label} MongoDB connection failed: ${redactMongoUri(uri)} db=${dbName}`);
    console.error(error.message);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  console.log(`Source Mongo: ${redactMongoUri(args.sourceUri)} db=${args.sourceDb}`);
  console.log(`Target Mongo: ${redactMongoUri(args.targetUri)} db=${args.targetDb}`);
  console.log(args.dryRun ? "Mode: dry run" : "Mode: copy with duplicate-safe upserts");

  const sourceClient = new MongoClient(args.sourceUri, { serverSelectionTimeoutMS: 5000 });
  const targetClient = new MongoClient(args.targetUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await connectMongo("Source", sourceClient, args.sourceUri, args.sourceDb);

    if (!args.dryRun) {
      await connectMongo("Target", targetClient, args.targetUri, args.targetDb);
    }

    const sourceDb = sourceClient.db(args.sourceDb);
    const targetDb = targetClient.db(args.targetDb);
    const collections = await listCollectionNames(sourceDb, args.collections);

    if (!collections.length) {
      console.log("No collections found to copy.");
      return 0;
    }

    let totalDocuments = 0;
    let totalInserted = 0;
    let totalSkipped = 0;

    for (const collectionName of collections) {
      const result = await copyCollection(sourceDb, targetDb, collectionName, args);
      totalDocuments += result.total;
      totalInserted += result.inserted;
      totalSkipped += result.skipped;

      console.log(
        [
          `${collectionName}: source ${result.total}`,
          `inserted ${result.inserted}`,
          `already in cloud ${result.skipped}`,
          `indexes ${result.indexes}`,
        ].join(", ")
      );
    }

    console.log(`Source documents scanned: ${totalDocuments}`);
    console.log(`Inserted in cloud: ${totalInserted}`);
    console.log(`Already in cloud: ${totalSkipped}`);
    return 0;
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
