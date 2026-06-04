"use strict";

const config = require("../config");
const { inclusiveDayCount, resolveDateRange } = require("../lib/dateRange");
const { labelFromKey, round, slugify } = require("../lib/format");
const { parseCsv } = require("../lib/http");

const INVENTORY_COLLECTION_SUFFIX = "_inventory";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 150;

function inventoryCollectionName(marketplaceKey) {
  return `${slugify(marketplaceKey)}${INVENTORY_COLLECTION_SUFFIX}`;
}

function marketplaceFromCollection(collectionName) {
  return collectionName.slice(0, -INVENTORY_COLLECTION_SUFFIX.length);
}

function numericValues(values) {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function normalizedIds(values) {
  const result = [];
  for (const value of values) {
    result.push(String(value));
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      result.push(numeric);
    }
  }
  return Array.from(new Set(result));
}

function eventCountExpression(fieldName = "$event_count") {
  return {
    $convert: {
      input: fieldName,
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

function workerExpression(fieldName = "$workers") {
  return {
    $convert: {
      input: fieldName,
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

function companyIdExpression() {
  return {
    $convert: {
      input: "$company_id",
      to: "string",
      onError: null,
      onNull: null,
    },
  };
}

function parseInventoryFilters(query = {}) {
  const dateRange = resolveDateRange({
    preset: query.preset || query.range || "last_7_days",
    from: query.from,
    to: query.to,
  });
  const workerMode = ["all", "zero", "active", "exact"].includes(query.worker_mode)
    ? query.worker_mode
    : "all";

  return {
    dateRange,
    companyIds: parseCsv(query.company_ids || query.company_id),
    eventTypes: parseCsv(query.event_types || query.event_type),
    workerMode,
    workers: numericValues(parseCsv(query.workers || query.worker)),
    sort: query.sort === "oldest" ? "oldest" : "latest",
    page: Math.max(Number.parseInt(query.page || "1", 10), 1),
    limit: Math.min(Math.max(Number.parseInt(query.limit || `${DEFAULT_LIMIT}`, 10), 1), MAX_LIMIT),
    groupBy: ["day", "week", "month"].includes(query.group_by) ? query.group_by : "day",
  };
}

function buildMatch(filters) {
  const match = {
    inventory_key: { $exists: true },
    date: {
      $gte: filters.dateRange.from,
      $lte: filters.dateRange.to,
    },
  };
  const and = [];

  if (filters.companyIds.length) {
    const companyIds = normalizedIds(filters.companyIds);
    and.push({
      $or: [
        { company_id: { $in: companyIds.map(String) } },
        { company_id_number: { $in: companyIds.filter((value) => typeof value === "number") } },
      ],
    });
  }

  if (filters.eventTypes.length) {
    match.event_type = { $in: filters.eventTypes };
  }

  if (filters.workerMode === "zero") {
    match.workers = 0;
  } else if (filters.workerMode === "active") {
    match.workers = { $gt: 0 };
  } else if (filters.workerMode === "exact" && filters.workers.length) {
    match.workers = { $in: filters.workers };
  }

  if (and.length) {
    match.$and = and;
  }

  return match;
}

async function listInventoryCollections(db) {
  const collectionInfos = await db.listCollections({}, { nameOnly: true }).toArray();
  const discovered = collectionInfos
    .map((collection) => collection.name)
    .filter((name) => name.endsWith(INVENTORY_COLLECTION_SUFFIX))
    .map(marketplaceFromCollection);

  return Array.from(new Set([...config.inventoryMarketplaces.map(slugify), ...discovered])).sort();
}

async function collectionExists(db, collectionName) {
  const matches = await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray();
  return matches.length > 0;
}

async function getMarketplaces(db) {
  const keys = await listInventoryCollections(db);

  return Promise.all(
    keys.map(async (key) => {
      const collectionName = inventoryCollectionName(key);
      const exists = await collectionExists(db, collectionName);
      const documentCount = exists
        ? await db.collection(collectionName).countDocuments({ inventory_key: { $exists: true } })
        : 0;

      return {
        key,
        label: labelFromKey(key),
        collection: collectionName,
        documentCount,
        available: exists,
      };
    })
  );
}

async function resolveMarketplaceKeys(db, query = {}) {
  const requested = parseCsv(query.marketplaces || query.marketplace);
  return requested.length ? requested.map(slugify) : listInventoryCollections(db);
}

async function aggregateSummary(collection, match, dateRange) {
  const [summary = {}] = await collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          event_count_number: eventCountExpression(),
          worker_number: workerExpression(),
        },
      },
      {
        $group: {
          _id: null,
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          companies: { $addToSet: "$company_id_text" },
          eventTypes: { $addToSet: "$event_type" },
          activeWorkerCompanies: {
            $addToSet: {
              $cond: [{ $gt: ["$worker_number", 0] }, "$company_id_text", null],
            },
          },
          latestDate: { $max: "$date" },
          oldestDate: { $min: "$date" },
          maxWorkers: { $max: "$worker_number" },
        },
      },
      {
        $project: {
          _id: 0,
          totalRows: 1,
          totalUpdates: 1,
          latestDate: 1,
          oldestDate: 1,
          maxWorkers: 1,
          totalCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
          totalEventTypes: { $size: { $setDifference: ["$eventTypes", [null, ""]] } },
          activeWorkerCompanies: {
            $size: { $setDifference: ["$activeWorkerCompanies", [null, ""]] },
          },
        },
      },
    ])
    .toArray();

  const dayCount = Math.max(inclusiveDayCount(dateRange.from, dateRange.to), 1);
  return {
    totalRows: summary.totalRows || 0,
    totalUpdates: summary.totalUpdates || 0,
    totalCompanies: summary.totalCompanies || 0,
    totalEventTypes: summary.totalEventTypes || 0,
    activeWorkerCompanies: summary.activeWorkerCompanies || 0,
    maxWorkers: summary.maxWorkers || 0,
    latestDate: summary.latestDate || null,
    oldestDate: summary.oldestDate || null,
    averageUpdatesPerDay: round((summary.totalUpdates || 0) / dayCount),
  };
}

async function aggregateDataCoverage(collection) {
  const [coverage = {}] = await collection
    .aggregate([
      { $match: { inventory_key: { $exists: true } } },
      {
        $addFields: {
          event_count_number: eventCountExpression(),
          company_id_text: companyIdExpression(),
        },
      },
      {
        $group: {
          _id: null,
          oldestDate: { $min: "$date" },
          latestDate: { $max: "$date" },
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          companies: { $addToSet: "$company_id_text" },
        },
      },
      {
        $project: {
          _id: 0,
          oldestDate: 1,
          latestDate: 1,
          totalRows: 1,
          totalUpdates: 1,
          totalCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
        },
      },
    ])
    .toArray();

  return {
    oldestDate: coverage.oldestDate || null,
    latestDate: coverage.latestDate || null,
    totalRows: coverage.totalRows || 0,
    totalUpdates: coverage.totalUpdates || 0,
    totalCompanies: coverage.totalCompanies || 0,
  };
}

async function aggregateTimeSeries(collection, match) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          event_count_number: eventCountExpression(),
          worker_number: workerExpression(),
        },
      },
      {
        $group: {
          _id: "$date",
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          companies: { $addToSet: "$company_id_text" },
          activeWorkerCompanies: {
            $addToSet: {
              $cond: [{ $gt: ["$worker_number", 0] }, "$company_id_text", null],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalRows: 1,
          totalUpdates: 1,
          activeCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
          activeWorkerCompanies: {
            $size: { $setDifference: ["$activeWorkerCompanies", [null, ""]] },
          },
        },
      },
      { $sort: { date: 1 } },
    ])
    .toArray();
}

async function aggregateEventTimeSeries(collection, match) {
  const rows = await collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          event_count_number: eventCountExpression(),
        },
      },
      {
        $group: {
          _id: {
            date: "$date",
            event_type: { $ifNull: ["$event_type", "unknown"] },
          },
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id.date",
          event_type: "$_id.event_type",
          totalRows: 1,
          totalUpdates: 1,
        },
      },
      { $sort: { date: 1, event_type: 1 } },
    ])
    .toArray();

  const rowsByDate = new Map();
  const eventsByKey = new Map();

  for (const item of rows) {
    const eventType = item.event_type || "unknown";
    const eventKey = slugify(eventType) || "unknown";
    const dateRow = rowsByDate.get(item.date) || {
      date: item.date,
      totalRows: 0,
      totalUpdates: 0,
    };
    const eventMeta = eventsByKey.get(eventKey) || {
      key: eventKey,
      event_type: eventType,
      label: labelFromKey(eventType),
      totalRows: 0,
      totalUpdates: 0,
    };

    dateRow[eventKey] = (dateRow[eventKey] || 0) + (item.totalUpdates || 0);
    dateRow.totalRows += item.totalRows || 0;
    dateRow.totalUpdates += item.totalUpdates || 0;

    eventMeta.totalRows += item.totalRows || 0;
    eventMeta.totalUpdates += item.totalUpdates || 0;

    rowsByDate.set(item.date, dateRow);
    eventsByKey.set(eventKey, eventMeta);
  }

  return {
    rows: Array.from(rowsByDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    events: Array.from(eventsByKey.values()).sort(
      (a, b) => b.totalUpdates - a.totalUpdates || a.label.localeCompare(b.label)
    ),
  };
}

async function aggregateEventTypes(collection, match, limit = 40) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          event_count_number: eventCountExpression(),
        },
      },
      {
        $group: {
          _id: "$event_type",
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          companies: { $addToSet: "$company_id_text" },
        },
      },
      {
        $project: {
          _id: 0,
          event_type: { $ifNull: ["$_id", "unknown"] },
          totalRows: 1,
          totalUpdates: 1,
          totalCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
        },
      },
      { $sort: { totalUpdates: -1, totalRows: -1, event_type: 1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function aggregateCompanyBreakdown(collection, match, limit = 20) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          event_count_number: eventCountExpression(),
          worker_number: workerExpression(),
        },
      },
      { $match: { company_id_text: { $nin: [null, ""] } } },
      {
        $group: {
          _id: "$company_id_text",
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          eventTypes: { $addToSet: "$event_type" },
          maxWorkers: { $max: "$worker_number" },
          activeWorkerRows: {
            $sum: { $cond: [{ $gt: ["$worker_number", 0] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          company_id: "$_id",
          totalRows: 1,
          totalUpdates: 1,
          maxWorkers: 1,
          activeWorkerRows: 1,
          totalEventTypes: { $size: { $setDifference: ["$eventTypes", [null, ""]] } },
        },
      },
      { $sort: { totalUpdates: -1, totalRows: -1, company_id: 1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function aggregateWorkerBreakdown(collection, match) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          event_count_number: eventCountExpression(),
          worker_number: workerExpression(),
        },
      },
      {
        $group: {
          _id: "$worker_number",
          totalRows: { $sum: 1 },
          totalUpdates: { $sum: "$event_count_number" },
          companies: { $addToSet: "$company_id_text" },
        },
      },
      {
        $project: {
          _id: 0,
          workers: "$_id",
          label: { $concat: [{ $toString: "$_id" }, " workers"] },
          totalRows: 1,
          totalUpdates: 1,
          totalCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
        },
      },
      { $sort: { workers: 1 } },
    ])
    .toArray();
}

async function aggregateBreakdowns(collection, match) {
  const [eventTypes, companies, workers] = await Promise.all([
    aggregateEventTypes(collection, match, 16),
    aggregateCompanyBreakdown(collection, match, 14),
    aggregateWorkerBreakdown(collection, match),
  ]);

  return {
    eventTypes,
    companies,
    workers,
  };
}

async function getCompanies(db, query = {}) {
  const marketplaceKey = slugify(query.marketplace);
  if (!marketplaceKey) {
    throw new Error("marketplace is required");
  }

  const filters = parseInventoryFilters(query);
  const collection = db.collection(inventoryCollectionName(marketplaceKey));
  const match = buildMatch(filters);

  return aggregateCompanyBreakdown(collection, match, 500);
}

function mergeNamedRows(rows, keyName) {
  const merged = new Map();
  for (const row of rows) {
    const key = String(row[keyName] ?? "unknown");
    const current = merged.get(key) || {
      [keyName]: row[keyName],
      totalRows: 0,
      totalUpdates: 0,
      totalCompanies: 0,
    };
    current.totalRows += row.totalRows || 0;
    current.totalUpdates += row.totalUpdates || 0;
    current.totalCompanies += row.totalCompanies || 0;
    merged.set(key, current);
  }

  return Array.from(merged.values()).sort(
    (a, b) => b.totalUpdates - a.totalUpdates || String(a[keyName]).localeCompare(String(b[keyName]))
  );
}

async function getEventTypes(db, query = {}) {
  const marketplaceKeys = await resolveMarketplaceKeys(db, query);
  const filters = {
    ...parseInventoryFilters(query),
    eventTypes: [],
  };

  const rows = await Promise.all(
    marketplaceKeys.map((marketplaceKey) =>
      aggregateEventTypes(db.collection(inventoryCollectionName(marketplaceKey)), buildMatch(filters), 100)
    )
  );

  return mergeNamedRows(rows.flat(), "event_type");
}

async function getWorkers(db, query = {}) {
  const marketplaceKeys = await resolveMarketplaceKeys(db, query);
  const filters = {
    ...parseInventoryFilters(query),
    workerMode: "all",
    workers: [],
  };

  const rows = await Promise.all(
    marketplaceKeys.map((marketplaceKey) =>
      aggregateWorkerBreakdown(db.collection(inventoryCollectionName(marketplaceKey)), buildMatch(filters))
    )
  );

  return mergeNamedRows(rows.flat(), "workers").map((row) => ({
    ...row,
    label: `${row.workers} workers`,
  }));
}

async function getRecentInventory(collection, match, filters) {
  const sortDirection = filters.sort === "oldest" ? 1 : -1;
  const skip = (filters.page - 1) * filters.limit;
  const projection = {
    company_id: 1,
    created_at: 1,
    date: 1,
    event_count: 1,
    event_type: 1,
    marketplace: 1,
    source_file: 1,
    workers: 1,
  };

  const [rows, total] = await Promise.all([
    collection
      .find(match)
      .project(projection)
      .sort({ date: sortDirection, company_id: 1, event_type: 1, _id: sortDirection })
      .skip(skip)
      .limit(filters.limit)
      .toArray(),
    collection.countDocuments(match),
  ]);

  return {
    rows: rows.map((row) => ({
      ...row,
      _id: String(row._id),
    })),
    page: filters.page,
    limit: filters.limit,
    total,
  };
}

function addSummaryDerivedFields(summary, timeSeries, breakdowns) {
  const activeDays = timeSeries.length;
  const topEventType = breakdowns.eventTypes[0] || null;
  const topCompany = breakdowns.companies[0] || null;

  return {
    ...summary,
    activeDays,
    topEventType,
    topCompany,
  };
}

async function getIndividualDashboard(db, query = {}) {
  const marketplaceKey = slugify(query.marketplace);
  if (!marketplaceKey) {
    throw new Error("marketplace is required");
  }

  const filters = parseInventoryFilters(query);
  const collectionName = inventoryCollectionName(marketplaceKey);
  const collection = db.collection(collectionName);
  const match = buildMatch(filters);

  const [summary, dataCoverage, timeSeries, eventTimeSeries, breakdowns, recent] = await Promise.all([
    aggregateSummary(collection, match, filters.dateRange),
    aggregateDataCoverage(collection),
    aggregateTimeSeries(collection, match),
    aggregateEventTimeSeries(collection, match),
    aggregateBreakdowns(collection, match),
    getRecentInventory(collection, match, filters),
  ]);

  return {
    marketplace: {
      key: marketplaceKey,
      label: labelFromKey(marketplaceKey),
      collection: collectionName,
    },
    filters,
    dataCoverage,
    summary: addSummaryDerivedFields(summary, timeSeries, breakdowns),
    timeSeries,
    eventTimeSeries,
    breakdowns,
    recent,
  };
}

function getIsoWeek(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function bucketForDate(dateValue, groupBy) {
  if (!dateValue) {
    return "unknown";
  }
  if (groupBy === "month") {
    return String(dateValue).slice(0, 7);
  }
  if (groupBy === "week") {
    const [year, month, day] = String(dateValue).split("-").map(Number);
    return getIsoWeek(new Date(year, month - 1, day));
  }
  return dateValue;
}

function groupTimeSeries(points, groupBy) {
  const buckets = new Map();

  for (const point of points) {
    const bucket = bucketForDate(point.date, groupBy);
    const current = buckets.get(bucket) || {
      bucket,
      totalUpdates: 0,
      totalRows: 0,
      activeCompanies: 0,
      activeWorkerCompanies: 0,
    };

    current.totalUpdates += point.totalUpdates || 0;
    current.totalRows += point.totalRows || 0;
    current.activeCompanies += point.activeCompanies || 0;
    current.activeWorkerCompanies += point.activeWorkerCompanies || 0;
    buckets.set(bucket, current);
  }

  return Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

async function getComparisonDashboard(db, query = {}) {
  const marketplaceKeys = await resolveMarketplaceKeys(db, query);
  const filters = parseInventoryFilters(query);

  const marketplaces = await Promise.all(
    marketplaceKeys.map(async (marketplaceKey) => {
      const collectionName = inventoryCollectionName(marketplaceKey);
      const collection = db.collection(collectionName);
      const match = buildMatch(filters);
      const [summary, dailySeries] = await Promise.all([
        aggregateSummary(collection, match, filters.dateRange),
        aggregateTimeSeries(collection, match),
      ]);

      return {
        key: marketplaceKey,
        label: labelFromKey(marketplaceKey),
        collection: collectionName,
        summary,
        timeSeries: groupTimeSeries(dailySeries, filters.groupBy),
      };
    })
  );

  const totalUpdates = marketplaces.reduce((sum, item) => sum + item.summary.totalUpdates, 0);
  const totalRows = marketplaces.reduce((sum, item) => sum + item.summary.totalRows, 0);
  const totalCompanies = marketplaces.reduce((sum, item) => sum + item.summary.totalCompanies, 0);
  const dayCount = Math.max(inclusiveDayCount(filters.dateRange.from, filters.dateRange.to), 1);
  const sorted = [...marketplaces].sort((a, b) => b.summary.totalUpdates - a.summary.totalUpdates);

  return {
    filters,
    summary: {
      totalUpdates,
      totalRows,
      totalCompanies,
      averageUpdatesPerDay: round(totalUpdates / dayCount),
      bestMarketplace: sorted[0] || null,
      lowestMarketplace: sorted[sorted.length - 1] || null,
    },
    contribution: marketplaces.map((item) => ({
      key: item.key,
      label: item.label,
      totalUpdates: item.summary.totalUpdates,
      totalRows: item.summary.totalRows,
      percentage: totalUpdates ? round((item.summary.totalUpdates / totalUpdates) * 100) : 0,
    })),
    companySplit: marketplaces.map((item) => ({
      key: item.key,
      label: item.label,
      activeCompanies: item.summary.totalCompanies,
      totalUpdates: item.summary.totalUpdates,
    })),
    marketplaces,
  };
}

module.exports = {
  getCompanies,
  getComparisonDashboard,
  getEventTypes,
  getIndividualDashboard,
  getMarketplaces,
  getWorkers,
  inventoryCollectionName,
  listInventoryCollections,
  parseInventoryFilters,
};
