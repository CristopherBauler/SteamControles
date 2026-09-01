/**
 * Banner de atualizações da wishlist (7 dias).
 * Lançamento, DLC, saída de early access, patches/hotfixes e notícias da Steam —
 * o mesmo feed "What's New" da biblioteca, só para jogos da lista de desejos.
 */

const { readJson, writeJson, nowIso, formatBRL, roundMoney } = require("./config");
const { fetchPartnerEvents, fetchAppNews, partnerEventImage, mapPool, isRateLimitError } = require("./steamApi");

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const NEWS_STALE_MS = 4 * 60 * 60 * 1000;
const NEWS_CONCURRENCY = 5;

const KIND_ORDER = {
  launch: 0,
  earlyAccess: 1,
  dlc: 2,
  majorUpdate: 3,
  update: 4,
  content: 5,
  smallUpdate: 6,
  news: 7,
  sale: 8,
  saleOff: 8,
  price: 9,
};

const STEAM_EVENT_KIND = {
  10: "launch",
  12: "smallUpdate",
  13: "update",
  14: "majorUpdate",
  15: "dlc",
  20: "sale",
  21: "sale",
  28: "news",
  29: "news",
  30: "content",
  32: "content",
  33: "update",
};

function comingSoonFlag(game) {
  const raw = game?.comingSoon ?? game?.coming_soon;
  if (raw == null) return null;
  return Boolean(raw);
}

function hasEarlyAccess(game) {
  if (game?.earlyAccess === true) return true;
  if (game?.earlyAccess === false) return false;
  const tags = game?.steamTags || game?.steam_tags || [];
  const list = Array.isArray(tags) ? tags : String(tags).split(",");
  return list.some((tag) => /early access|acesso antecipado/i.test(String(tag)));
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
    earlyAccess: hasEarlyAccess(game),
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
  if (curr.comingSoon === true) return false;
  if (curr.comingSoon !== false) return false;
  if (curr.releaseDate && isTbaReleaseDate(curr.releaseDate)) return false;
  if (curr.unavailable || (curr.currentPrice == null && !curr.isFree)) return false;

  const prevComingSoon = prev.comingSoon === true;
  const prevHiddenUnknown = prev.comingSoon == null && (prev.unavailable || prev.currentPrice == null);
  if (!prevComingSoon && !prevHiddenUnknown) return false;
  if (!prevComingSoon && curr.isFree && curr.currentPrice === 0) return false;
  return true;
}

function stripBb(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function makeEvent(curr, kind, text, extra = {}) {
  return {
    appId: curr.appId,
    name: curr.name,
    title: extra.title || curr.name,
    headerImage: extra.headerImage || curr.headerImage,
    storeUrl: extra.storeUrl || curr.storeUrl,
    kind,
    text,
    price: curr.currentPrice,
    discount: curr.discount,
    isFree: curr.currentPrice === 0,
    steamUpdate: !["sale", "saleOff", "price"].includes(kind),
    at: extra.at || nowIso(),
    gid: extra.gid || "",
    ...extra,
  };
}

function detectEvent(prev, curr) {
  if (!curr) return null;
  if (launchedNow(prev, curr)) {
    return makeEvent(curr, "launch", "Saiu na Steam e já pode comprar.");
  }
  if (!prev) return null;
  if (
    (prev.currentPrice == null || prev.unavailable) &&
    curr.currentPrice != null &&
    curr.comingSoon === false
  ) {
    const label = priceLabel(curr);
    return makeEvent(curr, "price", label ? `Preço disponível: ${label}` : "Preço disponível na loja.");
  }
  const prevDisc = Number(prev.discount || 0);
  const currDisc = Number(curr.discount || 0);
  const prevPrice = prev.currentPrice;
  const currPrice = curr.currentPrice;
  if (prevDisc >= 20 && currDisc === 0 && currPrice != null) {
    return makeEvent(curr, "saleOff", `Saiu da promoção · agora ${formatBRL(currPrice)}.`);
  }
  if (currPrice != null && prevPrice != null && prevPrice > 0 && currPrice > 0) {
    const drop = (prevPrice - currPrice) / prevPrice;
    if (currDisc - prevDisc >= 25 || drop >= 0.35) {
      return makeEvent(
        curr,
        "sale",
        currDisc ? `Entrou em promoção −${currDisc}%.` : `O preço caiu para ${formatBRL(currPrice)}.`
      );
    }
  }
  return null;
}

function isExternalNews(event) {
  const url = String(event?.storeUrl || event?.url || "");
  return /\/news\/externalpost\//i.test(url) || /gamemag\.ru/i.test(url);
}

function eventFromAppNews(curr, item) {
  const start = Number(item.date || 0) * 1000;
  if (!start || Date.now() - start > KEEP_MS) return null;
  if (item.is_external_url) return null;
  if (isExternalNews({ storeUrl: item.url })) return null;
  const title = stripBb(item.title || "").trim();
  if (!title) return null;
  if (/[\u0400-\u04FF]{6,}/.test(title)) return null;
  const blob = `${title} ${item.feedlabel || ""} ${item.feedname || ""}`;
  const kind = /\b(sale|promo|discount|deal|oferta|promoção|promocao)\b/i.test(blob) ? "sale" : "news";
  const gid = String(item.gid || item.url || title);
  return makeEvent(curr, kind, stripBb(item.contents || "").slice(0, 220) || title, {
    title,
    storeUrl: item.url || curr.storeUrl,
    at: new Date(start).toISOString(),
    gid: `news-${gid}`,
  });
}

function eventFromSteam(curr, raw) {
  const kind = STEAM_EVENT_KIND[Number(raw.event_type)];
  if (!kind) return null;
  const start = Number(raw.rtime32_start_time || raw.announcement_body?.posttime || 0) * 1000;
  if (!start || Date.now() - start > KEEP_MS || start > Date.now() + 12 * 60 * 60 * 1000) return null;
  let json = {};
  try {
    json = JSON.parse(raw.jsondata || "{}");
  } catch {
    json = {};
  }
  const summary = Array.isArray(json.localized_summary)
    ? json.localized_summary.find((item) => typeof item === "string" && item.trim())
    : "";
  const body = stripBb(raw.announcement_body?.body || "");
  const text = stripBb(summary || body).slice(0, 220);
  const title = String(raw.event_name || raw.announcement_body?.headline || curr.name).trim();
  const gid = String(raw.gid || raw.news_post_gid || "");
  const image = partnerEventImage(raw) || curr.headerImage;
  const url = gid
    ? `https://store.steampowered.com/news/app/${curr.appId}/${gid}`
    : curr.storeUrl;
  return makeEvent(curr, kind, text || title, {
    title,
    headerImage: image,
    storeUrl: url,
    at: new Date(start).toISOString(),
    gid,
  });
}

async function fetchWishlistNews(games, { language, refreshNews, fetchedAt, onProgress } = {}) {
  const stale = !fetchedAt || Date.now() - Date.parse(fetchedAt) > NEWS_STALE_MS;
  const report = (current, total) => {
    if (typeof onProgress === "function") onProgress({ current, total });
  };
  if (!refreshNews && !stale) {
    report(1, 1);
    return { events: [], skipped: true, limited: false };
  }

  let limited = false;
  const rows = await mapPool(games, NEWS_CONCURRENCY, async (curr) => {
    if (limited) return [];
    try {
      const raw = await fetchPartnerEvents(curr.appId, { language, count: 6 });
      const fromPartner = raw.map((item) => eventFromSteam(curr, item)).filter(Boolean);
      const hasNews = fromPartner.some((event) => event.kind === "news" || event.kind === "sale");
      if (hasNews) return fromPartner;
      let fromNews = [];
      try {
        const items = await fetchAppNews(curr.appId, { count: 5 });
        fromNews = items.map((item) => eventFromAppNews(curr, item)).filter(Boolean);
      } catch {
        fromNews = [];
      }
      return [...fromPartner, ...fromNews];
    } catch (error) {
      if (isRateLimitError(error)) limited = true;
      return [];
    }
  }, (done, total) => report(done, total));
  report(games.length || 1, games.length || 1);
  return { events: rows.flat(), skipped: false, limited };
}

async function collectWishlistUpdates({
  paths,
  games,
  previousWishlist = [],
  timezone = "America/Sao_Paulo",
  language = "brazilian",
  refreshNews = false,
  onProgress,
} = {}) {
  const stored = await readJson(paths.wishlistUpdates, { events: [], lastSeen: {} });
  const lastSeen = stored.lastSeen && typeof stored.lastSeen === "object" ? stored.lastSeen : {};
  const wishMap = new Map();
  for (const game of previousWishlist || []) {
    const snap = toSnapshot(game);
    if (snap) wishMap.set(snap.appId, snap);
  }

  const fresh = [];
  const nextSeen = { ...lastSeen };
  const wishNow = [];

  for (const game of games || []) {
    if (game.onWishlist === false) continue;
    const curr = toSnapshot(game);
    if (!curr) continue;
    const prev = lastSeen[String(curr.appId)] || wishMap.get(curr.appId) || null;
    if (curr.comingSoon == null && prev?.comingSoon != null) curr.comingSoon = prev.comingSoon;
    if (!curr.releaseDate && prev?.releaseDate) curr.releaseDate = prev.releaseDate;
    if (prev && prev.earlyAccess && curr.earlyAccess == null) curr.earlyAccess = prev.earlyAccess;
    wishNow.push(curr);
    if (prev) {
      const event = detectEvent(prev, curr);
      if (event) fresh.push(event);
    }
    if (
      Number(curr.discount) >= 15 &&
      curr.currentPrice != null &&
      curr.currentPrice > 0 &&
      curr.comingSoon !== true
    ) {
      fresh.push(
        makeEvent(curr, "sale", `Em promoção −${curr.discount}%.`, {
          gid: `onsale-${curr.appId}`,
          title: curr.name,
        })
      );
    }
    nextSeen[String(curr.appId)] = curr;
  }

  const cutoff = Date.now() - KEEP_MS;
  const kept = (stored.events || [])
    .filter((event) => {
      const t = Date.parse(event.at);
      if (!Number.isFinite(t) || t < cutoff) return false;
      if (event.kind === "earlyAccess" && !event.gid) return false;
      if (isExternalNews(event)) return false;
      if (/[\u0400-\u04FF]{6,}/.test(String(event.title || ""))) return false;
      if (event.kind === "launch") {
        const live = nextSeen[String(event.appId)];
        if (!live) return false;
        if (live.comingSoon === true) return false;
        if (live.comingSoon !== false) return false;
        if (live.unavailable || (live.currentPrice == null && !live.isFree)) return false;
      }
      return true;
    })
    .map((event) => ({ ...event, text: stripBb(event.text) }));

  const existingNews = kept.filter((event) => event.kind === "news" && event.gid).length;
  const news = await fetchWishlistNews(wishNow, {
    language,
    refreshNews: refreshNews || existingNews < 2,
    fetchedAt: stored.newsFetchedAt,
    onProgress,
  });
  if (news.events.length) fresh.push(...news.events);

  const keys = new Set();
  const titles = new Set();
  const events = [];
  for (const event of [...kept, ...fresh]) {
    const key = event.gid || `${event.appId}:${event.kind}:${String(event.at).slice(0, 10)}`;
    const titleKey = `${event.appId}:${String(event.title || event.text || "")
      .slice(0, 48)
      .toLowerCase()}`;
    if (keys.has(key) || titles.has(titleKey)) continue;
    keys.add(key);
    titles.add(titleKey);
    events.push(event);
  }
  events.sort((a, b) => {
    const dt = Date.parse(b.at) - Date.parse(a.at);
    if (dt) return dt;
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });
  const PROMO_KINDS = new Set(["sale", "saleOff", "price"]);
  const patches = [];
  const newsEvents = [];
  const promos = [];
  for (const event of events) {
    if (PROMO_KINDS.has(event.kind)) promos.push(event);
    else if (event.kind === "news") newsEvents.push(event);
    else patches.push(event);
  }
  const rankedSource = [...patches.slice(0, 12), ...newsEvents.slice(0, 12), ...promos.slice(0, 8)];
  const featuredKind = new Set(["launch", "earlyAccess", "dlc", "majorUpdate"]);
  const featuredAt = rankedSource.findIndex((item) => featuredKind.has(item.kind));
  const ranked = rankedSource.map((event, index) => ({
    ...event,
    featured: featuredAt >= 0 && index === featuredAt,
    timezone,
  }));

  const payload = {
    updatedAt: nowIso(),
    newsFetchedAt: news.skipped ? stored.newsFetchedAt || nowIso() : nowIso(),
    events: ranked,
    lastSeen: nextSeen,
  };
  await writeJson(paths.wishlistUpdates, payload);
  return {
    events: ranked,
    freshCount: fresh.length,
    newsCount: news.events.length,
    newsSkipped: news.skipped,
    newsLimited: news.limited,
  };
}

module.exports = {
  collectWishlistUpdates,
};
