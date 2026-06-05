"use strict";

const config = require("../config");
const { inclusiveDayCount, resolveDateRange } = require("../lib/dateRange");
const { labelFromKey, round, slugify } = require("../lib/format");
const { parseCsv } = require("../lib/http");

const ORDER_COLLECTION_SUFFIX = "_order";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function orderCollectionName(marketplaceKey) {
  return `${slugify(marketplaceKey)}${ORDER_COLLECTION_SUFFIX}`;
}

function marketplaceFromCollection(collectionName) {
  return collectionName.slice(0, -ORDER_COLLECTION_SUFFIX.length);
}

function quantityExpression(fieldName = "$quantity_total") {
  return {
    $convert: {
      input: fieldName,
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

function amountExpression(fieldName = "$amount_paid_total") {
  return {
    $convert: {
      input: fieldName,
      to: "double",
      onError: 0,
      onNull: 0,
    },
  };
}

function hasAmountExpression(fieldName = "$amount_paid_total") {
  return {
    $and: [
      { $ne: [fieldName, null] },
      { $ne: [fieldName, ""] },
    ],
  };
}

function companyIdExpression() {
  return {
    $convert: {
      input: {
        $ifNull: ["$company_id", { $arrayElemAt: ["$company_ids", 0] }],
      },
      to: "string",
      onError: null,
      onNull: null,
    },
  };
}

function orderNoExpression() {
  return {
    $convert: {
      input: "$order_no",
      to: "string",
      onError: null,
      onNull: null,
    },
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function parseOrderFilters(query = {}) {
  const dateRange = resolveDateRange({
    preset: query.preset || query.range || "last_7_days",
    from: query.from,
    to: query.to,
  });

  return {
    dateRange,
    companyIds: parseCsv(query.company_ids || query.company_id),
    eventTypes: parseCsv(query.event_types || query.event_type),
    payloadVersions: parseCsv(query.payload_versions || query.payload_version),
    search: query.search ? String(query.search).trim() : "",
    sort: query.sort === "oldest" ? "oldest" : "latest",
    page: Math.max(Number.parseInt(query.page || "1", 10), 1),
    limit: Math.min(Math.max(Number.parseInt(query.limit || `${DEFAULT_LIMIT}`, 10), 1), MAX_LIMIT),
    groupBy: ["day", "week", "month"].includes(query.group_by) ? query.group_by : "day",
  };
}

function buildMatch(filters, options = {}) {
  const match = {
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
        { company_id: { $in: companyIds } },
        { company_ids: { $in: companyIds } },
      ],
    });
  }

  if (filters.eventTypes.length) {
    match.event_type = { $in: filters.eventTypes };
  }

  if (filters.payloadVersions.length) {
    match.payload_version = { $in: filters.payloadVersions };
  }

  if (options.includeSearch && filters.search) {
    const regex = new RegExp(escapeRegex(filters.search), "i");
    and.push({
      $or: [
        { order_no: regex },
        { fynd_order_id: regex },
        { shipment_order_ids: regex },
      ],
    });
  }

  if (and.length) {
    match.$and = and;
  }

  return match;
}

async function listOrderCollections(db) {
  const collectionInfos = await db.listCollections({}, { nameOnly: true }).toArray();
  const discovered = collectionInfos
    .map((collection) => collection.name)
    .filter((name) => name.endsWith(ORDER_COLLECTION_SUFFIX))
    .map(marketplaceFromCollection);

  return Array.from(new Set([...config.orderMarketplaces.map(slugify), ...discovered])).sort();
}

async function collectionExists(db, collectionName) {
  const matches = await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray();
  return matches.length > 0;
}

async function getMarketplaces(db) {
  const keys = await listOrderCollections(db);

  return Promise.all(
    keys.map(async (key) => {
      const collectionName = orderCollectionName(key);
      const exists = await collectionExists(db, collectionName);
      const documentCount = exists ? await db.collection(collectionName).estimatedDocumentCount() : 0;

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

async function getCompanies(db, query = {}) {
  const marketplaceKey = slugify(query.marketplace);
  if (!marketplaceKey) {
    throw new Error("marketplace is required");
  }

  const filters = parseOrderFilters(query);
  const collection = db.collection(orderCollectionName(marketplaceKey));
  const match = buildMatch(filters);

  return collection
    .aggregate([
      { $match: match },
      { $addFields: { company_id_text: companyIdExpression() } },
      { $match: { company_id_text: { $nin: [null, ""] } } },
      {
        $group: {
          _id: "$company_id_text",
          totalEvents: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
        },
      },
      {
        $project: {
          _id: 0,
          company_id: "$_id",
          totalEvents: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
        },
      },
      { $sort: { uniqueOrders: -1, company_id: 1 } },
    ])
    .toArray();
}

async function aggregateSummary(collection, match, dateRange) {
  const [summary = {}] = await collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          company_id_text: companyIdExpression(),
          amount_paid_number: amountExpression(),
          has_amount: { $cond: [hasAmountExpression(), 1, 0] },
        },
      },
      {
        $group: {
          _id: null,
          totalEvents: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
          companies: { $addToSet: "$company_id_text" },
          totalQuantity: { $sum: quantityExpression() },
          totalAmount: { $sum: "$amount_paid_number" },
          amountRows: { $sum: "$has_amount" },
          amountCurrencies: { $addToSet: "$amount_paid_currency" },
          duplicateOrderEvents: {
            $sum: { $cond: [{ $eq: ["$is_duplicate_order_id", true] }, 1, 0] },
          },
          latestDate: { $max: "$date" },
          oldestDate: { $min: "$date" },
          latestTimestamp: { $max: "$timestamp_utc" },
          oldestTimestamp: { $min: "$timestamp_utc" },
        },
      },
      {
        $project: {
          _id: 0,
          totalEvents: 1,
          totalQuantity: 1,
          totalAmount: 1,
          amountRows: 1,
          amountCurrencies: 1,
          duplicateOrderEvents: 1,
          latestDate: 1,
          oldestDate: 1,
          latestTimestamp: 1,
          oldestTimestamp: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
          totalCompanies: { $size: { $setDifference: ["$companies", [null, ""]] } },
        },
      },
    ])
    .toArray();

  const dayCount = Math.max(inclusiveDayCount(dateRange.from, dateRange.to), 1);
  return {
    totalEvents: summary.totalEvents || 0,
    uniqueOrders: summary.uniqueOrders || 0,
    totalCompanies: summary.totalCompanies || 0,
    totalQuantity: summary.totalQuantity || 0,
    totalAmount: round(summary.totalAmount || 0, 2),
    amountRows: summary.amountRows || 0,
    amountCurrency: (summary.amountCurrencies || []).filter(Boolean)[0] || "INR",
    amountCurrencies: (summary.amountCurrencies || []).filter(Boolean),
    duplicateOrderEvents: summary.duplicateOrderEvents || 0,
    latestDate: summary.latestDate || null,
    oldestDate: summary.oldestDate || null,
    latestTimestamp: summary.latestTimestamp || null,
    oldestTimestamp: summary.oldestTimestamp || null,
    averageOrdersPerDay: round((summary.uniqueOrders || 0) / dayCount),
  };
}

async function aggregateAmountSummary(collection, match) {
  const [summary = {}] = await collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          amount_paid_number: amountExpression(),
          company_id_text: companyIdExpression(),
          order_no_text: orderNoExpression(),
        },
      },
      {
        $match: {
          amount_paid_total: { $exists: true, $nin: [null, ""] },
          order_no_text: { $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: {
            company_id: "$company_id_text",
            order_no: "$order_no_text",
          },
          orderAmount: { $max: "$amount_paid_number" },
        },
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$orderAmount" },
          amountOrders: { $sum: 1 },
          averageAmountPerOrder: { $avg: "$orderAmount" },
        },
      },
      {
        $project: {
          _id: 0,
          totalAmount: 1,
          amountOrders: 1,
          averageAmountPerOrder: 1,
        },
      },
    ])
    .toArray();

  return {
    totalAmount: round(summary.totalAmount || 0, 2),
    amountOrders: summary.amountOrders || 0,
    averageAmountPerOrder: round(summary.averageAmountPerOrder || 0, 2),
  };
}

function mergeAmountSummary(summary, amountSummary) {
  return {
    ...summary,
    totalAmount: amountSummary.totalAmount || 0,
    amountOrders: amountSummary.amountOrders || 0,
    averageAmountPerOrder: amountSummary.averageAmountPerOrder || 0,
  };
}

async function aggregateDataCoverage(collection) {
  const [coverage = {}] = await collection
    .aggregate([
      {
        $group: {
          _id: null,
          oldestDate: { $min: "$date" },
          latestDate: { $max: "$date" },
          totalRows: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
        },
      },
      {
        $project: {
          _id: 0,
          oldestDate: 1,
          latestDate: 1,
          totalRows: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
        },
      },
    ])
    .toArray();

  return {
    oldestDate: coverage.oldestDate || null,
    latestDate: coverage.latestDate || null,
    totalRows: coverage.totalRows || 0,
    uniqueOrders: coverage.uniqueOrders || 0,
  };
}

async function aggregateTimeSeries(collection, match) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          amount_paid_number: amountExpression(),
          has_amount: { $cond: [hasAmountExpression(), 1, 0] },
        },
      },
      {
        $group: {
          _id: "$date",
          totalEvents: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
          successCount: {
            $sum: { $cond: [{ $eq: ["$event_type", "fynd_create_success"] }, 1, 0] },
          },
          attemptCount: {
            $sum: { $cond: [{ $eq: ["$event_type", "fynd_create_attempt"] }, 1, 0] },
          },
          totalQuantity: { $sum: quantityExpression() },
          totalAmount: { $sum: "$amount_paid_number" },
          amountRows: { $sum: "$has_amount" },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalEvents: 1,
          successCount: 1,
          attemptCount: 1,
          totalQuantity: 1,
          totalAmount: 1,
          amountRows: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
        },
      },
      { $sort: { date: 1 } },
    ])
    .toArray();
}

async function aggregateAmountTimeSeries(collection, match) {
  const rows = await collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          amount_paid_number: amountExpression(),
          company_id_text: companyIdExpression(),
          order_no_text: orderNoExpression(),
        },
      },
      {
        $match: {
          amount_paid_total: { $exists: true, $nin: [null, ""] },
          order_no_text: { $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: {
            date: "$date",
            company_id: "$company_id_text",
            order_no: "$order_no_text",
          },
          orderAmount: { $max: "$amount_paid_number" },
        },
      },
      {
        $group: {
          _id: "$_id.date",
          totalAmount: { $sum: "$orderAmount" },
          amountOrders: { $sum: 1 },
          averageAmountPerOrder: { $avg: "$orderAmount" },
        },
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalAmount: 1,
          amountOrders: 1,
          averageAmountPerOrder: 1,
        },
      },
      { $sort: { date: 1 } },
    ])
    .toArray();

  return rows.map((row) => ({
    ...row,
    totalAmount: round(row.totalAmount || 0, 2),
    averageAmountPerOrder: round(row.averageAmountPerOrder || 0, 2),
  }));
}

function mergeAmountTimeSeries(timeSeries, amountSeries) {
  const amountByDate = new Map(amountSeries.map((point) => [point.date, point]));
  return timeSeries.map((point) => {
    const amountPoint = amountByDate.get(point.date) || {};
    return {
      ...point,
      totalAmount: amountPoint.totalAmount || 0,
      amountOrders: amountPoint.amountOrders || 0,
      averageAmountPerOrder: amountPoint.averageAmountPerOrder || 0,
    };
  });
}

async function aggregateNamedBreakdown(collection, match, fieldExpression, outputName = "name", limit = 12) {
  return collection
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: fieldExpression,
          totalEvents: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
        },
      },
      {
        $project: {
          _id: 0,
          [outputName]: { $ifNull: ["$_id", "unknown"] },
          totalEvents: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
        },
      },
      { $sort: { uniqueOrders: -1, totalEvents: -1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function aggregateCompanyBreakdown(collection, match, limit = 12) {
  return collection
    .aggregate([
      { $match: match },
      { $addFields: { company_id_text: companyIdExpression() } },
      { $match: { company_id_text: { $nin: [null, ""] } } },
      {
        $group: {
          _id: "$company_id_text",
          totalEvents: { $sum: 1 },
          uniqueOrders: { $addToSet: "$order_no" },
          totalQuantity: { $sum: quantityExpression() },
          totalAmount: { $sum: amountExpression() },
        },
      },
      {
        $project: {
          _id: 0,
          company_id: "$_id",
          totalEvents: 1,
          totalQuantity: 1,
          totalAmount: 1,
          uniqueOrders: { $size: { $setDifference: ["$uniqueOrders", [null, ""]] } },
        },
      },
      { $sort: { uniqueOrders: -1, totalEvents: -1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function aggregateCompanyAmountBreakdown(collection, match, limit = 12) {
  return collection
    .aggregate([
      { $match: match },
      {
        $addFields: {
          amount_paid_number: amountExpression(),
          company_id_text: companyIdExpression(),
          order_no_text: orderNoExpression(),
        },
      },
      {
        $match: {
          amount_paid_total: { $exists: true, $nin: [null, ""] },
          company_id_text: { $nin: [null, ""] },
          order_no_text: { $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: {
            company_id: "$company_id_text",
            order_no: "$order_no_text",
          },
          orderAmount: { $max: "$amount_paid_number" },
        },
      },
      {
        $group: {
          _id: "$_id.company_id",
          totalAmount: { $sum: "$orderAmount" },
          amountOrders: { $sum: 1 },
          averageAmountPerOrder: { $avg: "$orderAmount" },
        },
      },
      {
        $project: {
          _id: 0,
          company_id: "$_id",
          totalAmount: 1,
          amountOrders: 1,
          averageAmountPerOrder: 1,
        },
      },
      { $sort: { totalAmount: -1, amountOrders: -1, company_id: 1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function aggregateBreakdowns(collection, match) {
  const [eventTypes, paymentModes, payloadVersions, companies, amountCompanies] = await Promise.all([
    aggregateNamedBreakdown(collection, match, { $ifNull: ["$event_type", "unknown"] }, "event_type", 16),
    aggregateNamedBreakdown(
      collection,
      match,
      { $ifNull: ["$primary_payment_mode", { $ifNull: ["$payment_mode", "unknown"] }] },
      "payment_mode",
      12
    ),
    aggregateNamedBreakdown(collection, match, { $ifNull: ["$payload_version", "unknown"] }, "payload_version", 8),
    aggregateCompanyBreakdown(collection, match),
    aggregateCompanyAmountBreakdown(collection, match),
  ]);

  return {
    eventTypes,
    paymentModes,
    payloadVersions,
    companies,
    amountCompanies,
  };
}

async function getRecentOrders(collection, match, filters) {
  const searchMatch = buildMatch(filters, { includeSearch: true });
  const sortDirection = filters.sort === "oldest" ? 1 : -1;
  const skip = (filters.page - 1) * filters.limit;
  const projection = {
    amount_paid_currency: 1,
    amount_paid_total: 1,
    company_id: 1,
    company_ids: 1,
    date: 1,
    event_type: 1,
    external_location_ids: 1,
    fynd_order_id: 1,
    line_item_count: 1,
    marketplace: 1,
    order_no: 1,
    payload_version: 1,
    payment_mode: 1,
    primary_payment_mode: 1,
    quantity_total: 1,
    shipment_order_ids: 1,
    store_ids: 1,
    timestamp_ist: 1,
    timestamp_utc: 1,
  };

  const [rows, total] = await Promise.all([
    collection
      .find(filters.search ? searchMatch : match)
      .project(projection)
      .sort({ timestamp_utc: sortDirection, date: sortDirection, _id: sortDirection })
      .skip(skip)
      .limit(filters.limit)
      .toArray(),
    collection.countDocuments(filters.search ? searchMatch : match),
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

function addSummaryDerivedFields(summary, timeSeries) {
  const successCount = timeSeries.reduce((sum, point) => sum + (point.successCount || 0), 0);
  const attemptCount = timeSeries.reduce((sum, point) => sum + (point.attemptCount || 0), 0);
  return {
    ...summary,
    successCount,
    attemptCount,
    successRate: attemptCount ? round((successCount / attemptCount) * 100) : 0,
  };
}

async function getIndividualDashboard(db, query = {}) {
  const marketplaceKey = slugify(query.marketplace);
  if (!marketplaceKey) {
    throw new Error("marketplace is required");
  }

  const filters = parseOrderFilters(query);
  const collectionName = orderCollectionName(marketplaceKey);
  const collection = db.collection(collectionName);
  const match = buildMatch(filters);

  const [summary, amountSummary, dataCoverage, rawTimeSeries, amountTimeSeries, breakdowns, recent] = await Promise.all([
    aggregateSummary(collection, match, filters.dateRange),
    aggregateAmountSummary(collection, match),
    aggregateDataCoverage(collection),
    aggregateTimeSeries(collection, match),
    aggregateAmountTimeSeries(collection, match),
    aggregateBreakdowns(collection, match),
    getRecentOrders(collection, match, filters),
  ]);
  const timeSeries = mergeAmountTimeSeries(rawTimeSeries, amountTimeSeries);

  return {
    marketplace: {
      key: marketplaceKey,
      label: labelFromKey(marketplaceKey),
      collection: collectionName,
    },
    filters,
    dataCoverage,
    summary: addSummaryDerivedFields(mergeAmountSummary(summary, amountSummary), timeSeries),
    timeSeries,
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
      uniqueOrders: 0,
      totalEvents: 0,
      successCount: 0,
      attemptCount: 0,
      totalQuantity: 0,
      totalAmount: 0,
      amountRows: 0,
    };

    current.uniqueOrders += point.uniqueOrders || 0;
    current.totalEvents += point.totalEvents || 0;
    current.successCount += point.successCount || 0;
    current.attemptCount += point.attemptCount || 0;
    current.totalQuantity += point.totalQuantity || 0;
    current.totalAmount += point.totalAmount || 0;
    current.amountRows += point.amountRows || 0;
    buckets.set(bucket, current);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      totalAmount: round(bucket.totalAmount || 0, 2),
      averageAmountPerOrder: bucket.amountOrders ? round(bucket.totalAmount / bucket.amountOrders, 2) : 0,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

async function getComparisonDashboard(db, query = {}) {
  const requestedMarketplaces = parseCsv(query.marketplaces || query.marketplace);
  const marketplaceKeys = requestedMarketplaces.length
    ? requestedMarketplaces.map(slugify)
    : await listOrderCollections(db);
  const filters = parseOrderFilters(query);

  const marketplaces = await Promise.all(
    marketplaceKeys.map(async (marketplaceKey) => {
      const collectionName = orderCollectionName(marketplaceKey);
      const collection = db.collection(collectionName);
      const match = buildMatch(filters);
      const [summary, amountSummary, dailySeries, amountTimeSeries] = await Promise.all([
        aggregateSummary(collection, match, filters.dateRange),
        aggregateAmountSummary(collection, match),
        aggregateTimeSeries(collection, match),
        aggregateAmountTimeSeries(collection, match),
      ]);
      const mergedDailySeries = mergeAmountTimeSeries(dailySeries, amountTimeSeries);
      const groupedSeries = groupTimeSeries(mergedDailySeries, filters.groupBy);
      const enrichedSummary = addSummaryDerivedFields(mergeAmountSummary(summary, amountSummary), mergedDailySeries);

      return {
        key: marketplaceKey,
        label: labelFromKey(marketplaceKey),
        collection: collectionName,
        summary: enrichedSummary,
        timeSeries: groupedSeries,
      };
    })
  );

  const totalUniqueOrders = marketplaces.reduce((sum, item) => sum + item.summary.uniqueOrders, 0);
  const totalEvents = marketplaces.reduce((sum, item) => sum + item.summary.totalEvents, 0);
  const totalCompanies = marketplaces.reduce((sum, item) => sum + item.summary.totalCompanies, 0);
  const totalAmount = marketplaces.reduce((sum, item) => sum + item.summary.totalAmount, 0);
  const amountRows = marketplaces.reduce((sum, item) => sum + item.summary.amountRows, 0);
  const amountOrders = marketplaces.reduce((sum, item) => sum + item.summary.amountOrders, 0);
  const dayCount = Math.max(inclusiveDayCount(filters.dateRange.from, filters.dateRange.to), 1);
  const sorted = [...marketplaces].sort((a, b) => b.summary.uniqueOrders - a.summary.uniqueOrders);

  return {
    filters,
    summary: {
      totalUniqueOrders,
      totalEvents,
      totalCompanies,
      totalAmount: round(totalAmount, 2),
      amountRows,
      amountOrders,
      amountCurrency: "INR",
      averageAmountPerOrder: amountOrders ? round(totalAmount / amountOrders, 2) : 0,
      averageOrdersPerDay: round(totalUniqueOrders / dayCount),
      bestMarketplace: sorted[0] || null,
      lowestMarketplace: sorted[sorted.length - 1] || null,
    },
    contribution: marketplaces.map((item) => ({
      key: item.key,
      label: item.label,
      uniqueOrders: item.summary.uniqueOrders,
      totalEvents: item.summary.totalEvents,
      totalAmount: item.summary.totalAmount,
      amountOrders: item.summary.amountOrders,
      averageAmountPerOrder: item.summary.averageAmountPerOrder,
      percentage: totalUniqueOrders ? round((item.summary.uniqueOrders / totalUniqueOrders) * 100) : 0,
      amountPercentage: totalAmount ? round((item.summary.totalAmount / totalAmount) * 100) : 0,
    })),
    companySplit: marketplaces.map((item) => ({
      key: item.key,
      label: item.label,
      activeCompanies: item.summary.totalCompanies,
      uniqueOrders: item.summary.uniqueOrders,
      totalAmount: item.summary.totalAmount,
      amountOrders: item.summary.amountOrders,
    })),
    marketplaces,
  };
}

module.exports = {
  getCompanies,
  getComparisonDashboard,
  getIndividualDashboard,
  getMarketplaces,
  listOrderCollections,
  orderCollectionName,
  parseOrderFilters,
};
