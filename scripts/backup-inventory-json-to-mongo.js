#!/usr/bin/env node

"use strict";

const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");

const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB_NAME = "v1_traffic";
const DEFAULT_BATCH_SIZE = 1000;

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function displayMarketplace(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(process.cwd(), filePath);
}

function inferMarketplace(filePath) {
  return displayMarketplace(path.basename(path.dirname(filePath)));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const args = {
    files: [],
    mongoUri: process.env.MONGO_URI || DEFAULT_MONGO_URI,
    dbName: process.env.MONGO_DB || DEFAULT_DB_NAME,
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--file") {
      args.files.push(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--files") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        args.files.push(argv[index + 1]);
        index += 1;
      }
    } else if (arg === "--files-json") {
      const files = JSON.parse(requiredValue(argv, index, arg));
      if (!Array.isArray(files)) {
        throw new Error("--files-json must be a JSON array");
      }
      args.files.push(...files);
      index += 1;
    } else if (arg === "--mongo-uri") {
      args.mongoUri = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--db") {
      args.dbName = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--batch-size") {
      args.batchSize = Number.parseInt(requiredValue(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }

  args.files = Array.from(new Set(args.files.map((file) => String(file).trim()).filter(Boolean)));
  return args;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/backup-inventory-json-to-mongo.js --files <file...>",
    "",
    "Options:",
    "  --file <path>          Add one inventory JSON file. Can be repeated.",
    "  --files <paths...>     Add many files until the next --option.",
    "  --files-json <json>    Add files from a JSON array string.",
    "  --mongo-uri <uri>      Default: mongodb://127.0.0.1:27017",
    "  --db <name>            Default: v1_traffic",
    "  --dry-run              Parse and summarize without writing to MongoDB.",
  ].join("\n");
}

function flattenInventory(payload, options) {
  const createdAt = new Date();
  const documents = [];

  for (const [date, companies] of Object.entries(payload || {})) {
    if (!companies || typeof companies !== "object" || Array.isArray(companies)) {
      continue;
    }

    for (const [companyId, companyPayload] of Object.entries(companies)) {
      if (!companyPayload || typeof companyPayload !== "object" || Array.isArray(companyPayload)) {
        continue;
      }

      const events = companyPayload.events || {};
      const workers = toNumber(companyPayload.workers);

      for (const [eventType, eventCount] of Object.entries(events)) {
        const inventoryKey = [
          options.marketplaceKey,
          date,
          String(companyId),
          String(eventType),
        ].join("|");

        documents.push({
          date,
          company_id: String(companyId),
          company_id_number: toNumber(companyId, null),
          event_type: String(eventType),
          event_count: toNumber(eventCount),
          workers,
          has_workers: workers > 0,
          marketplace: options.marketplace,
          marketplace_key: options.marketplaceKey,
          record_type: "inventory",
          source_file: options.sourceFile,
          inventory_key: inventoryKey,
          created_at: createdAt,
          create_at: createdAt,
        });
      }
    }
  }

  return documents;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function prepareJob(filePath) {
  const sourceFile = resolvePath(filePath);
  const stat = await fs.stat(sourceFile);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${sourceFile}`);
  }

  const raw = (await fs.readFile(sourceFile, "utf8")).trim();
  const payload = raw ? JSON.parse(raw) : {};
  const marketplace = inferMarketplace(sourceFile);
  const marketplaceKey = slugify(marketplace);
  const collectionName = `${marketplaceKey}_inventory`;
  const documents = flattenInventory(payload, {
    sourceFile,
    marketplace,
    marketplaceKey,
  });

  return {
    sourceFile,
    marketplace,
    marketplaceKey,
    collectionName,
    documents,
  };
}

async function ensureIndexes(collection) {
  await collection.createIndex(
    { inventory_key: 1 },
    {
      name: "inventory_key_1",
      unique: true,
      background: true,
      partialFilterExpression: { inventory_key: { $exists: true } },
    }
  );
  await collection.createIndex({ date: 1 }, { name: "inventory_date_idx", background: true });
  await collection.createIndex({ company_id: 1, date: 1 }, { name: "inventory_company_date_idx", background: true });
  await collection.createIndex({ event_type: 1, date: 1 }, { name: "inventory_event_date_idx", background: true });
  await collection.createIndex({ workers: 1, date: 1 }, { name: "inventory_workers_date_idx", background: true });
}

async function insertDocuments(db, job, batchSize) {
  const collection = db.collection(job.collectionName);
  await ensureIndexes(collection);

  let inserted = 0;
  let skipped = 0;

  for (const batch of chunk(job.documents, batchSize)) {
    const operations = batch.map((document) => ({
      updateOne: {
        filter: { inventory_key: document.inventory_key },
        update: { $setOnInsert: document },
        upsert: true,
      },
    }));
    const result = await collection.bulkWrite(operations, { ordered: false });
    inserted += result.upsertedCount || 0;
    skipped += result.matchedCount || 0;
  }

  return { inserted, skipped };
}

function printSummary(job, mongoUri, dbName) {
  const dates = new Set(job.documents.map((document) => document.date));
  const companies = new Set(job.documents.map((document) => document.company_id));
  const eventTypes = new Set(job.documents.map((document) => document.event_type));

  console.log(`Source file: ${job.sourceFile}`);
  console.log(`Mongo target: ${mongoUri}/${dbName}.${job.collectionName}`);
  console.log(`Marketplace: ${job.marketplace}`);
  console.log(`Inventory rows ready: ${job.documents.length}`);
  console.log(`Dates: ${dates.size}`);
  console.log(`Companies: ${companies.size}`);
  console.log(`Event types: ${eventTypes.size}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.files.length) {
    throw new Error(`No files provided.\n\n${usage()}`);
  }

  const jobs = [];
  for (const filePath of args.files) {
    const job = await prepareJob(filePath);
    jobs.push(job);
    printSummary(job, args.mongoUri, args.dbName);
    if (!job.documents.length) {
      console.log("No inventory rows found. MongoDB will not be changed for this file.");
    }
    console.log("");
  }

  if (args.dryRun) {
    console.log("Dry run complete. MongoDB was not changed.");
    return 0;
  }

  const client = new MongoClient(args.mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    const db = client.db(args.dbName);

    let totalInserted = 0;
    let totalSkipped = 0;

    for (const job of jobs) {
      if (!job.documents.length) {
        continue;
      }
      const result = await insertDocuments(db, job, args.batchSize);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      console.log(`${job.collectionName}: inserted ${result.inserted}, already backed up ${result.skipped}`);
    }

    console.log(`Inserted inventory rows: ${totalInserted}`);
    console.log(`Already backed up: ${totalSkipped}`);
    console.log("Source files were not modified.");
    return 0;
  } finally {
    await client.close();
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
