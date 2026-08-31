/**
 * Histórico diário de preços. Nunca apaga entradas.
 */

const path = require("path");
const { readJson, writeJson, roundMoney, todayInTimezone } = require("./config");

function emptyHistory() {
  return { games: {} };
}

function dateKey(isoOrDate, timezone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(isoOrDate))) return String(isoOrDate);
  const date = isoOrDate ? new Date(isoOrDate) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function loadHistory(historyPath) {
  const data = await readJson(historyPath, emptyHistory());
  if (!data.games || typeof data.games !== "object") data.games = {};
  return data;
}

async function saveHistory(historyPath, data) {
  await writeJson(historyPath, data);
}

async function migrateLegacyIfNeeded(paths, timezone) {
  const history = await loadHistory(paths.history);
  const legacy = await readJson(path.join(paths.data, "steamPrices.json"), null);
  if (!legacy?.games) return history;

  for (const [appId, game] of Object.entries(legacy.games)) {
    const bucket = history.games[appId] || {
      appId: Number(appId),
      name: game.name,
      entries: [],
    };
    const seen = new Set(bucket.entries.map((entry) => entry.date));
    for (const item of game.history || []) {
      const date = dateKey(item.date, timezone);
      if (seen.has(date)) continue;
      bucket.entries.push({
        date,
        price: roundMoney(item.price),
        discount: Number(item.discount || 0),
        initialPrice: roundMoney(game.initialPrice),
      });
      seen.add(date);
    }
    bucket.entries.sort((a, b) => a.date.localeCompare(b.date));
    history.games[appId] = bucket;
  }
  await saveHistory(paths.history, history);
  return history;
}

function appendDaily(history, game, timezone) {
  const id = String(game.appId);
  const today = todayInTimezone(timezone);
  const bucket = history.games[id] || {
    appId: game.appId,
    name: game.name,
    entries: [],
  };
  bucket.name = game.name || bucket.name;
  ensureBasePrice(bucket, game);

  const snapshot = {
    date: today,
    price: roundMoney(game.currentPrice),
    discount: Number(game.discount || 0),
    initialPrice: roundMoney(game.initialPrice),
  };

  const existingIndex = bucket.entries.findIndex((entry) => entry.date === today);
  if (existingIndex >= 0) {
    bucket.entries[existingIndex] = snapshot;
  } else {
    bucket.entries.push(snapshot);
  }
  bucket.entries.sort((a, b) => a.date.localeCompare(b.date));
  history.games[id] = bucket;
  return bucket;
}

function inferBasePrice(entries) {
  const first = (entries || []).find((entry) => entry.price != null || entry.initialPrice != null);
  if (!first) return null;
  if (Number(first.discount) > 0) return roundMoney(first.initialPrice ?? first.price);
  return roundMoney(first.initialPrice ?? first.price);
}

function ensureBasePrice(bucket, game) {
  if (bucket.basePrice != null) return roundMoney(bucket.basePrice);
  const fromHistory = inferBasePrice(bucket.entries);
  if (fromHistory != null) {
    bucket.basePrice = fromHistory;
    return fromHistory;
  }
  if (game) {
    const onSale = Number(game.discount) > 0;
    bucket.basePrice = roundMoney(
      onSale ? game.initialPrice ?? game.currentPrice : game.initialPrice ?? game.currentPrice
    );
  }
  return bucket.basePrice ?? null;
}

/**
 * Verde: promoção (abaixo do normal).
 * Azul: preço cheio, igual ao valor gravado.
 * Vermelho: o preço cheio subiu em relação ao que foi salvo.
 */
function colorStatus({ currentPrice, discount, initialPrice, basePrice }) {
  const current = roundMoney(currentPrice);
  if (current === 0) return "queda";
  if (current == null) return "igual";
  const list = roundMoney(initialPrice);
  const onSale =
    Number(discount) > 0 || (list != null && current < list - 0.01);
  if (onSale) return "queda";
  const base = roundMoney(basePrice);
  if (base != null && current > base + 0.05) return "alta";
  return "igual";
}

function previousSnapshot(entries, today) {
  const older = (entries || []).filter((entry) => entry.date < today);
  return older.at(-1) || null;
}

function lowestPrice(entries) {
  const prices = (entries || [])
    .map((entry) => entry.price)
    .filter((price) => price != null && price > 0);
  if (!prices.length) return null;
  return roundMoney(Math.min(...prices));
}

function lastSale(entries) {
  const sales = (entries || []).filter((entry) => Number(entry.discount) > 0);
  return sales.at(-1) || null;
}

function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

function summarize(entries, today, extra = {}) {
  const current = (entries || []).find((entry) => entry.date === today) || entries?.at(-1) || null;
  const previous = previousSnapshot(entries, today);
  const currentPrice = current?.price ?? null;
  const previousPrice = previous?.price ?? currentPrice;
  const priceDiff =
    currentPrice == null || previousPrice == null ? 0 : roundMoney(currentPrice - previousPrice);
  const sale = lastSale(entries);
  const onSale = Number(current?.discount || 0) > 0;
  const daysSinceSale = onSale ? 0 : daysBetween(sale?.date, today);
  const basePrice = roundMoney(extra.basePrice) ?? inferBasePrice(entries);

  const status = colorStatus({
    currentPrice,
    discount: current?.discount,
    initialPrice: current?.initialPrice,
    basePrice,
  });

  return {
    currentPrice,
    previousPrice,
    priceDiff,
    discount: Number(current?.discount || 0),
    saleAmount:
      current?.initialPrice != null && currentPrice != null
        ? roundMoney(current.initialPrice - currentPrice)
        : 0,
    lowestPrice: lowestPrice(entries),
    status,
    lastSaleDate: sale?.date || null,
    daysSinceSale,
    onSale,
    basePrice,
    history: entries || [],
  };
}

module.exports = {
  loadHistory,
  saveHistory,
  migrateLegacyIfNeeded,
  appendDaily,
  summarize,
  dateKey,
  colorStatus,
  ensureBasePrice,
  inferBasePrice,
};
