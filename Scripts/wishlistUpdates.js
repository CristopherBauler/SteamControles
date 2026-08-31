/**
 * Banner de lançamentos / atualizações da wishlist.
 * Guarda last-seen e eventos por ~7 dias em Data/wishlistUpdates.json.
 */

const { readJson, writeJson, nowIso, formatBRL, roundMoney } = require("./config");

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KIND_ORDER = { launch: 0, steam: 1, price: 2, sale: 3 };

function comingSoonFlag(game) {
  const raw = game?.comingSoon ?? game?.coming_soon;
  if (raw == null) return null;
  return Boolean(raw);
}

function isTbaReleaseDate(date) {
  const text = String(date || "").trim();
  if (!text) return false;
  return /to be announced|a ser anunciad|em breve|^tba$|coming soon|quando estiver/i.test(text);
}

function toSnapshot(game) {
  if (!game) return null;
  const appId = Number(game.appId ?? game.steam_appid);
  if (!Number.isInteger(appId) || appId <= 0) return null;
  const priceRaw = game.currentPrice ?? game.current_price;
  const price = priceRaw == null ? null : roundMoney(priceRaw);
  const comingSoon = comingSoonFlag(game);
  const isFree = Boolean(game.isFree ?? game.is_free) || price === 0;
  return {
    appId,
    name: game.name || `App ${appId}`,
    headerImage: game.headerImage || game.header_image || "",
    storeUrl: game.storeUrl || game.store_url || `https://store.steampowered.com/app/${appId}`,
    currentPrice: price,
    discount: Number(game.discount || 0),
    comingSoon,
    isFree,
    releaseDate: String(game.releaseDate || game.release_date || "").trim(),
    unavailable: Boolean(game.unavailable) || price == null,
  };
}

function priceLabel(snap) {
  if (!snap) return "";
  if (snap.currentPrice === 0 || snap.isFree) return "Free";
  if (snap.currentPrice != null) return formatBRL(snap.currentPrice);
  return "";
}

function launchedNow(prev, curr) {
  if (!prev || !curr) return false;
  // Still coming soon, or unknown: never a launch (Free / is_free is not enough).
  if (curr.comingSoon === true) return false;
  if (curr.comingSoon !== false) return false;
  if (curr.releaseDate && isTbaReleaseDate(curr.releaseDate)) return false;
  // No store price and not a live F2P title — still unreleased / region-blocked.
  if (curr.unavailable || (curr.currentPrice == null && !curr.isFree)) return false;

  const prevComingSoon = prev.comingSoon === true;
  const prevHiddenUnknown = prev.comingSoon == null && (prev.unavailable || prev.currentPrice == null);
  if (!prevComingSoon && !prevHiddenUnknown) return false;
  if (!prevComingSoon && curr.isFree && curr.currentPrice === 0) return false;
  return true;
}

function makeEvent(curr, kind, text, extra = {}) {
  return {
    appId: curr.appId,
    name: curr.name,
    headerImage: curr.headerImage,
    storeUrl: curr.storeUrl,
    kind,
    text,
    price: curr.currentPrice,
    discount: curr.discount,
    isFree: curr.currentPrice === 0,
    steamUpdate: kind === "launch" || kind === "steam",
    at: nowIso(),
    ...extra,
  };
}

function detectEvent(prev, curr) {
  if (!curr) return null;
  if (launchedNow(prev, curr)) {
    return makeEvent(curr, "launch", "foi lançado");
  }
  if (!prev) return null;
  if (
    (prev.currentPrice == null || prev.unavailable) &&
    curr.currentPrice != null &&
    curr.comingSoon === false
  ) {
    const label = priceLabel(curr);
    return makeEvent(curr, "price", label ? `preço disponível ${label}` : "preço disponível");
  }
  if (prev.comingSoon === true && curr.comingSoon === false && !curr.unavailable && curr.currentPrice != null) {
    return makeEvent(curr, "steam", "teve atualização na Steam");
  }
  const prevDisc = Number(prev.discount || 0);
  const currDisc = Number(curr.discount || 0);
  const prevPrice = prev.currentPrice;
  const currPrice = curr.currentPrice;
  if (currPrice != null && prevPrice != null && prevPrice > 0 && currPrice > 0) {
    const drop = (prevPrice - currPrice) / prevPrice;
    if (currDisc - prevDisc >= 25 || drop >= 0.35) {
      return makeEvent(
        curr,
        "sale",
        currDisc ? `entrou em promoção -${currDisc}%` : `preço caiu ${formatBRL(currPrice)}`
      );
    }
  }
  return null;
}

async function collectWishlistUpdates({ paths, games, previousWishlist = [] }) {
  const stored = await readJson(paths.wishlistUpdates, { events: [], lastSeen: {} });
  const lastSeen = stored.lastSeen && typeof stored.lastSeen === "object" ? stored.lastSeen : {};
  const wishMap = new Map();
  for (const game of previousWishlist || []) {
    const snap = toSnapshot(game);
    if (snap) wishMap.set(snap.appId, snap);
  }

  const fresh = [];
  const nextSeen = { ...lastSeen };

  for (const game of games || []) {
    if (game.onWishlist === false) continue;
    const curr = toSnapshot(game);
    if (!curr) continue;
    const prev = lastSeen[String(curr.appId)] || wishMap.get(curr.appId) || null;
    if (curr.comingSoon == null && prev?.comingSoon != null) curr.comingSoon = prev.comingSoon;
    if (!curr.releaseDate && prev?.releaseDate) curr.releaseDate = prev.releaseDate;
    if (prev) {
      const event = detectEvent(prev, curr);
      if (event) fresh.push(event);
    }
    nextSeen[String(curr.appId)] = curr;
  }

  const cutoff = Date.now() - KEEP_MS;
  const kept = (stored.events || []).filter((event) => {
    const t = Date.parse(event.at);
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (event.kind === "launch") {
      const live = nextSeen[String(event.appId)];
      if (!live) return false;
      if (live.comingSoon === true) return false;
      if (live.comingSoon !== false) return false;
      if (live.unavailable || (live.currentPrice == null && !live.isFree)) return false;
    }
    return true;
  });
  const keys = new Set(kept.map((event) => `${event.appId}:${event.kind}`));
  const events = [...kept];
  for (const event of fresh) {
    const key = `${event.appId}:${event.kind}`;
    if (keys.has(key)) continue;
    events.push(event);
    keys.add(key);
  }
  events.sort((a, b) => {
    const dt = Date.parse(b.at) - Date.parse(a.at);
    if (dt) return dt;
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });

  const payload = {
    updatedAt: nowIso(),
    events: events.slice(0, 24),
    lastSeen: nextSeen,
  };
  await writeJson(paths.wishlistUpdates, payload);
  return { events: events.slice(0, 5), freshCount: fresh.length };
}

module.exports = {
  collectWishlistUpdates,
};
