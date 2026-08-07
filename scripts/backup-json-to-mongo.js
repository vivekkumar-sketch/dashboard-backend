#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

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

function inferMarketplace(filePath) {
  const parentFolder = path.basename(path.dirname(filePath));
  if (!parentFolder) {
    throw new Error(`Could not infer marketplace from path: ${filePath}`);
  }
  return displayMarketplace(parentFolder);
}

function inferDataType(filePath) {
  const fileName = path.basename(filePath, path.extname(filePath)).toLowerCase();
  if (fileName.includes("inventory")) {
    return "inventory";
  }
  if (fileName.includes("order")) {
    return "order";
  }
  return slugify(fileName);
}

function resolvePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(process.cwd(), filePath);
}

function parseJsonValues(rawText) {
  const raw = rawText.trim();
  if (!raw) {
    return [];
  }

  try {
    return [JSON.parse(raw)];
  } catch (error) {
    return parseConsecutiveJsonValues(raw);
  }
}

function parseConsecutiveJsonValues(raw) {
  const values = [];
  let index = 0;

  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) {
      index += 1;
    }
    if (index >= raw.length) {
      break;
    }

    const endIndex = findJsonValueEnd(raw, index);
    const jsonText = raw.slice(index, endIndex);
    values.push(JSON.parse(jsonText));
    index = endIndex;
  }

  return values;
}

function findJsonValueEnd(raw, startIndex) {
  const first = raw[startIndex];

  if (first === "{" || first === "[") {
    const openers = new Set(["{", "["]);
    const closers = { "}": "{", "]": "[" };
    const stack = [];
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (openers.has(char)) {
        stack.push(char);
      } else if (Object.prototype.hasOwnProperty.call(closers, char)) {
        if (stack.pop() !== closers[char]) {
          throw new Error(`Invalid JSON near character ${index}`);
        }
        if (stack.length === 0) {
          return index + 1;
        }
      }
    }

    throw new Error("Could not find the end of a JSON object/array");
  }

  let index = startIndex;
  while (index < raw.length && !/\s/.test(raw[index])) {
    index += 1;
  }
  return index;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toRecord(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return cloneJson(value);
  }
  return { value: cloneJson(value) };
}

function inventoryRecords(payload) {
  const records = [];

  for (const [date, companyPayload] of Object.entries(payload)) {
    if (companyPayload === null || typeof companyPayload !== "object" || Array.isArray(companyPayload)) {
      records.push({ date, value: cloneJson(companyPayload) });
      continue;
    }

    for (const [companyId, inventoryPayload] of Object.entries(companyPayload)) {
      const record = toRecord(inventoryPayload);
      if (!Object.prototype.hasOwnProperty.call(record, "date")) {
        record.date = date;
      }
      if (!Object.prototype.hasOwnProperty.call(record, "company_id")) {
        record.company_id = companyId;
      }
      records.push(record);
    }
  }

  return records;
}

function sourceRecords(jsonValues, dataType) {
  const records = [];

  for (const value of jsonValues) {
    if (Array.isArray(value)) {
      for (const item of value) {
        records.push(toRecord(item));
      }
      continue;
    }

    if (value !== null && typeof value === "object") {
      if (Object.keys(value).length === 0) {
        continue;
      }
      if (dataType === "inventory") {
        records.push(...inventoryRecords(value));
      } else {
        records.push(cloneJson(value));
      }
      continue;
    }

    records.push({ value: cloneJson(value) });
  }

  return records;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function backupHash(record, collectionName, marketplaceKey, dataType) {
  const hashInput = {
    collection: collectionName,
    marketplace_key: marketplaceKey,
    record_type: dataType,
    record,
  };

  return crypto.createHash("sha256").update(stableStringify(hashInput)).digest("hex");
}

function buildDocuments(records, options) {
  const createdAt = new Date();
  const byHash = new Map();

  for (const record of records) {
    const originalRecord = cloneJson(record);
    const document = cloneJson(record);

    if (
      Object.prototype.hasOwnProperty.call(document, "marketplace") &&
      document.marketplace !== options.marketplace
    ) {
      document.source_marketplace = document.marketplace;
    }

    document.created_at = createdAt;
    document.create_at = createdAt;
    document.marketplace = options.marketplace;
    document.marketplace_key = options.marketplaceKey;
    document.record_type = options.dataType;
    document.source_file = options.sourceFile;
    document.backup_hash = backupHash(
      originalRecord,
      options.collectionName,
      options.marketplaceKey,
      options.dataType
    );

    byHash.set(document.backup_hash, document);
  }

  return Array.from(byHash.values());
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseArgs(argv) {
  const args = {
    files: [],
    mongoUri: process.env.MONGO_URI || DEFAULT_MONGO_URI,
    dbName: process.env.MONGO_DB || DEFAULT_DB_NAME,
    marketplace: "",
    dataType: "",
    collection: "",
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--file") {
      args.files.push(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--files") {
      const files = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        files.push(argv[index + 1]);
        index += 1;
      }
      args.files.push(...files);
    } else if (arg === "--files-json") {
      const files = JSON.parse(requiredValue(argv, index, arg));
      if (!Array.isArray(files)) {
        throw new Error("--files-json must be a JSON array of file paths");
      }
      args.files.push(...files);
      index += 1;
    } else if (arg === "--mongo-uri") {
      args.mongoUri = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--db") {
      args.dbName = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--marketplace") {
      args.marketplace = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--data-type") {
      args.dataType = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--collection") {
      args.collection = requiredValue(argv, index, arg);
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
    "  node scripts/backup-json-to-mongo.js --files <file...> [--dry-run]",
    "  node scripts/backup-json-to-mongo.js --files-json '[\"v1/data/ajio/create_order.json\"]'",
    "",
    "Options:",
    "  --file <path>          Add one file. Can be repeated.",
    "  --files <paths...>     Add many files until the next --option.",
    "  --files-json <json>    Add files from a JSON array string.",
    "  --mongo-uri <uri>      Default: mongodb://127.0.0.1:27017",
    "  --db <name>            Default: v1_traffic",
    "  --marketplace <name>   Optional override. By default inferred from parent folder.",
    "  --data-type <name>     Optional override. By default inferred from file name.",
    "  --collection <name>    Optional override. By default <marketplace>_<data-type>.",
    "  --dry-run              Parse and summarize without writing to MongoDB.",
  ].join("\n");
}

async function prepareJob(filePath, args) {
  const sourceFile = resolvePath(filePath);
  const stat = await fs.stat(sourceFile);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${sourceFile}`);
  }

  const marketplace = args.marketplace ? displayMarketplace(args.marketplace) : inferMarketplace(sourceFile);
  const marketplaceKey = slugify(marketplace);
  const dataType = args.dataType ? slugify(args.dataType) : inferDataType(sourceFile);
  const collectionName = args.collection ? slugify(args.collection) : `${marketplaceKey}_${dataType}`;
  const raw = await fs.readFile(sourceFile, "utf8");
  const records = sourceRecords(parseJsonValues(raw), dataType);
  const documents = buildDocuments(records, {
    sourceFile,
    collectionName,
    marketplace,
    marketplaceKey,
    dataType,
  });

  return {
    sourceFile,
    marketplace,
    dataType,
    collectionName,
    documents,
  };
}

function loadMongoClient() {
  try {
    return require("mongodb").MongoClient;
  } catch (error) {
    throw new Error("mongodb package is not installed. Run: npm install");
  }
}

async function insertDocuments(db, collectionName, documents, batchSize) {
  const collection = db.collection(collectionName);
  await collection.createIndex({ backup_hash: 1 }, { unique: true, background: true });

  let inserted = 0;
  let skipped = 0;

  for (const batch of chunk(documents, batchSize)) {
    const operations = batch.map((document) => ({
      updateOne: {
        filter: { backup_hash: document.backup_hash },
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

function printJobSummary(job, mongoUri, dbName) {
  console.log(`Source file: ${job.sourceFile}`);
  console.log(`Mongo target: ${mongoUri}/${dbName}.${job.collectionName}`);
  console.log(`Marketplace: ${job.marketplace}`);
  console.log(`Record type: ${job.dataType}`);
  console.log(`Documents ready: ${job.documents.length}`);
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
    const job = await prepareJob(filePath, args);
    jobs.push(job);
    printJobSummary(job, args.mongoUri, args.dbName);
    if (!job.documents.length) {
      console.log("No records found. MongoDB will not be changed for this file.");
    }
    console.log("");
  }

  if (args.dryRun) {
    console.log("Dry run complete. MongoDB was not changed.");
    return 0;
  }

  const MongoClient = loadMongoClient();
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

      const result = await insertDocuments(db, job.collectionName, job.documents, args.batchSize);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      console.log(`${job.collectionName}: inserted ${result.inserted}, already backed up ${result.skipped}`);
    }

    console.log(`Inserted documents: ${totalInserted}`);
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
