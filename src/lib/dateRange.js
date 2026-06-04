"use strict";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) {
    return null;
  }
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function resolveDateRange({ preset = "last_7_days", from, to } = {}) {
  const explicitFrom = parseDate(from);
  const explicitTo = parseDate(to);

  if (explicitFrom && explicitTo) {
    return {
      preset: "custom",
      from: formatDate(explicitFrom),
      to: formatDate(explicitTo),
    };
  }

  const today = new Date();
  const end = explicitTo || addDays(today, -1);
  let days = 7;

  if (preset === "last_1_day") {
    days = 1;
  } else if (preset === "last_2_days") {
    days = 2;
  } else if (preset === "last_month" || preset === "last_30_days") {
    days = 30;
  }

  const start = explicitFrom || addDays(end, -(days - 1));

  return {
    preset,
    from: formatDate(start),
    to: formatDate(end),
  };
}

function inclusiveDayCount(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end || end < start) {
    return 0;
  }
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

module.exports = {
  formatDate,
  inclusiveDayCount,
  resolveDateRange,
};
