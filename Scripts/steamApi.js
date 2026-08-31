/**
 * Cliente das APIs públicas da Steam.
 * Wishlist precisa estar pública no perfil.
 */

const { centsToReais, sleep } = require("./config");

const STEAM_HEADERS = {
  "User-Agent": "SteamWishlistDashboard/2.0 (Obsidian local)",
  Accept: "application/json, text/xml;q=0.9, */*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

const REVIEW_LABELS = {
  "Overwhelmingly Positive": "Extremamente positivas",
  "Very Positive": "Muito positivas",
  Positive: "Positivas",
  "Mostly Positive": "Ligeiramente positivas",
  Mixed: "Análises mistas",
  "Mostly Negative": "Ligeiramente negativas",
  Negative: "Negativas",
  "Very Negative": "Muito negativas",
  "Overwhelmingly Negative": "Extremamente negativas",
};

async function fetchJson(url, { retries = 3, timeoutMs = 25000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: STEAM_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} em ${url}`);
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("xml") || contentType.includes("html")) {
        return await response.text();
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

function extractSteamId64(value) {
  const text = String(value || "").trim();
  const profile = text.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profile) return profile[1];
  if (/^7656119\d{10}$/.test(text)) return text;
  return null;
}

function extractVanity(value) {
  const text = String(value || "").trim();
  const vanity = text.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (vanity) return decodeURIComponent(vanity[1]);
  if (text && !extractSteamId64(text) && !/^https?:/i.test(text) && !/^\d+$/.test(text)) {
    return text;
  }
  return null;
}

async function resolveSteamId({ steamId, profileUrl }) {
  const direct = extractSteamId64(steamId) || extractSteamId64(profileUrl);
  if (direct) return direct;

  const vanity = extractVanity(profileUrl) || extractVanity(steamId);
  if (!vanity) {
    throw new Error(
      "Informe steamId (SteamID64) ou rode conectar-steam.bat."
    );
  }

  const xml = await fetchJson(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`);
  const match = String(xml).match(/<steamID64>(\d{17})<\/steamID64>/);
  if (!match) {
    throw new Error(`Não foi possível resolver o perfil "${vanity}". Confira a URL.`);
  }
  return match[1];
}

async function fetchWishlist(steamId64) {
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId64}`;
  const payload = await fetchJson(url);
  const items = payload?.response?.items;

  if (!Array.isArray(items)) {
    throw new Error(
      "Wishlist inacessível. Deixe a lista de desejos PÚBLICA em: Perfil Steam → Privacidade."
    );
  }

  if (items.length === 0) {
    let count = 0;
    try {
      const countPayload = await fetchJson(
        `https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/?steamid=${steamId64}`
      );
      count = Number(countPayload?.response?.count || 0);
    } catch {
      count = 0;
    }
    if (count > 0) {
      throw new Error(
        `A Steam reporta ${count} jogos, mas não devolveu a lista. A wishlist provavelmente está privada.`
      );
    }
  }

  return items
    .map((item) => ({
      appId: Number(item.appid),
      priority: Number(item.priority || 0),
      dateAdded: item.date_added ? Number(item.date_added) : null,
    }))
    .filter((item) => Number.isInteger(item.appId) && item.appId > 0);
}

function capsuleUrl(appId) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
}

function parseAppDetails(appId, data) {
  const overview = data?.price_overview;
  const isFree = Boolean(data?.is_free);
  const genres = (data?.genres || []).map((item) => item.description).filter(Boolean);
  const categories = (data?.categories || []).map((item) => item.description).filter(Boolean);
  const tags = [...new Set([...genres, ...categories])].slice(0, 5);

  return {
    appId,
    name: data?.name || `App ${appId}`,
    isFree,
    available: Boolean(overview) || isFree,
    currentPrice: isFree ? 0 : centsToReais(overview?.final),
    initialPrice: isFree ? 0 : centsToReais(overview?.initial),
    discount: isFree ? 0 : Number(overview?.discount_percent || 0),
    currency: overview?.currency || "BRL",
    headerImage: data?.header_image || "",
    capsuleImage: data?.header_image || "",
    storeUrl: `https://store.steampowered.com/app/${appId}`,
    steamTags: tags,
    shortDescription: data?.short_description || "",
    developers: data?.developers || [],
    publishers: data?.publishers || [],
    comingSoon: Boolean(data?.release_date?.coming_soon),
  };
}

async function fetchAppDetails(appId, { country, language }) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appId));
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);

  const payload = await fetchJson(url);
  const entry = payload?.[String(appId)];
  if (!entry?.success || !entry.data) {
    return {
      appId,
      name: `App ${appId}`,
      isFree: false,
      available: false,
      currentPrice: null,
      initialPrice: null,
      discount: 0,
      currency: "BRL",
      headerImage: "",
      capsuleImage: "",
      storeUrl: `https://store.steampowered.com/app/${appId}`,
      steamTags: [],
      shortDescription: "",
      developers: [],
      publishers: [],
      comingSoon: false,
      unavailable: true,
    };
  }
  return parseAppDetails(appId, entry.data);
}

async function fetchPriceOverview(appId, { country, language }) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appId));
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);
  url.searchParams.set("filters", "price_overview");

  const payload = await fetchJson(url, { retries: 1, timeoutMs: 12000 });
  const entry = payload?.[String(appId)];
  const data = entry?.data || {};
  const overview = data.price_overview;
  const isFree = Boolean(data.is_free);
  if (!entry?.success) {
    return { appId, currentPrice: null, initialPrice: null, discount: 0, unavailable: true };
  }
  return {
    appId,
    currentPrice: isFree ? 0 : centsToReais(overview?.final),
    initialPrice: isFree ? 0 : centsToReais(overview?.initial),
    discount: isFree ? 0 : Number(overview?.discount_percent || 0),
    unavailable: !overview && !isFree,
  };
}

async function fetchReviews(appId) {
  const url = new URL(`https://store.steampowered.com/appreviews/${appId}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("language", "all");
  url.searchParams.set("purchase_type", "all");
  url.searchParams.set("num_per_page", "0");
  url.searchParams.set("filter", "summary");

  try {
    const payload = await fetchJson(url);
    const summary = payload?.query_summary || {};
    const total = Number(summary.total_reviews || 0);
    const percent = total > 0 ? Math.round((Number(summary.total_positive || 0) / total) * 100) : null;
    const english = summary.review_score_desc || "";
    return {
      reviewDesc: REVIEW_LABELS[english] || english || null,
      reviewPercent: percent,
      reviewTotal: total || null,
    };
  } catch {
    return { reviewDesc: null, reviewPercent: null, reviewTotal: null };
  }
}

async function fetchOwnedGames(steamId64) {
  const xml = await fetchJson(
    `https://steamcommunity.com/profiles/${steamId64}/games?tab=all&xml=1`
  );
  const text = String(xml || "");
  if (!text.includes("<appID>")) {
    return { ids: new Set(), privateProfile: true };
  }
  const ids = new Set(
    [...text.matchAll(/<appID>(\d+)<\/appID>/gi)].map((match) => Number(match[1]))
  );
  return { ids, privateProfile: false };
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function fetchMostWanted({ country = "br", language = "portuguese", limit = 20 } = {}) {
  return fetchSearchCatalog({
    country,
    language,
    limit,
    params: { filter: "popularwishlist" },
  });
}

function parseSearchCatalog(html, limit) {
  const blocks = String(html || "").split(/data-ds-appid="/).slice(1);
  const seen = new Set();
  const games = [];

  for (const block of blocks) {
    const appId = Number(block.match(/^(\d+)/)?.[1]);
    if (!Number.isInteger(appId) || appId <= 0 || seen.has(appId)) continue;
    seen.add(appId);
    const name =
      block.match(/<span class="title">([^<]+)/)?.[1] ||
      block.match(/class=\\"title\\">([^<]+)/)?.[1] ||
      block.match(/class="title">([^<]+)/)?.[1] ||
      `App ${appId}`;
    const image =
      block.match(/search_capsule"><img src="([^"]+)"/)?.[1] ||
      block.match(/src="(https:\/\/[^"]+\/apps\/[^"]+)"/)?.[1] ||
      "";
    const cents = Number(block.match(/data-price-final="(\d+)"/)?.[1] || 0);
    const discount = Number(
      block.match(/discount_pct[^>]*>\s*-?(\d+)\s*%/)?.[1] ||
        block.match(/-(\d+)\s*%/)?.[1] ||
        0
    );
    games.push({
      rank: games.length + 1,
      appId,
      name: decodeHtml(name),
      image,
      headerImage: image,
      currentPrice: cents > 0 ? centsToReais(cents) : null,
      discount,
      status: "igual",
      ggDealsUrl: `https://gg.deals/steam/app/${appId}/`,
      storeUrl: `https://store.steampowered.com/app/${appId}`,
      source: "Steam",
    });
    if (games.length >= limit) break;
  }
  return games;
}

async function fetchSearchCatalog({
  country = "br",
  language = "portuguese",
  limit = 20,
  start = 0,
  params = {},
} = {}) {
  const url = new URL("https://store.steampowered.com/search/results/");
  url.searchParams.set("start", String(start));
  url.searchParams.set("count", String(limit));
  url.searchParams.set("infinite", "1");
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const payload = await fetchJson(url);
  return parseSearchCatalog(payload?.results_html || "", limit);
}

async function fetchSpecialsCatalog({ country = "br", language = "portuguese", limit = 80 } = {}) {
  const pageSize = 50;
  const games = [];
  const seen = new Set();
  for (let start = 0; start < limit; start += pageSize) {
    const take = Math.min(pageSize, limit - start);
    const page = await fetchSearchCatalog({
      country,
      language,
      limit: take,
      start,
      params: { specials: "1" },
    });
    if (!page.length) break;
    for (const game of page) {
      if (game.appId && seen.has(game.appId)) continue;
      if (game.appId) seen.add(game.appId);
      games.push({ ...game, rank: games.length + 1 });
    }
    if (page.length < take) break;
  }
  return games;
}

function mapStoreItem(item, source = "Steam") {
  const appId = Number(item.id);
  const hasId = Number.isInteger(appId) && appId > 0;
  return {
    appId: hasId ? appId : null,
    name: decodeHtml(item.name),
    image: item.large_capsule_image || item.header_image || "",
    smallImage: item.small_capsule_image || item.header_image || "",
    headerImage: item.header_image || item.large_capsule_image || "",
    currentPrice: item.final_price != null ? centsToReais(item.final_price) : null,
    discount: Number(item.discount_percent || 0),
    storeUrl: item.url || (hasId ? `https://store.steampowered.com/app/${appId}` : "https://store.steampowered.com/"),
    source,
  };
}

async function fetchStoreHub({ country = "br", language = "portuguese" } = {}) {
  const url = new URL("https://store.steampowered.com/api/featuredcategories");
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);
  const data = await fetchJson(url);

  const events = [];
  for (const key of Object.keys(data)) {
    if (!/^\d+$/.test(key)) continue;
    const cat = data[key] || {};
    for (const item of cat.items || []) {
      const mapped = mapStoreItem(item, cat.name || "Steam");
      let body = decodeHtml(
        String(item.body || "").replace(/%\d\$s/g, "").replace(/\s+/g, " ")
      );
      if (!body || /termina em\s*\.?$/i.test(body)) body = cat.name || "";
      events.push({
        name: mapped.name,
        image: item.header_image || mapped.image,
        url: mapped.storeUrl,
        body,
      });
    }
  }

  const specials = (data.specials?.items || []).map((item) => mapStoreItem(item, "Steam"));
  const newReleaseDeals = (data.new_releases?.items || [])
    .filter((item) => item.discounted)
    .map((item) => mapStoreItem(item, "Steam"));
  const seenNew = new Set(newReleaseDeals.map((item) => item.appId).filter(Boolean));
  const newDeals = [...newReleaseDeals];
  for (const item of specials) {
    if (newDeals.length >= 10) break;
    if (item.appId && seenNew.has(item.appId)) continue;
    newDeals.push(item);
  }

  const bestDeals = [...specials]
    .sort((a, b) => Number(b.discount || 0) - Number(a.discount || 0))
    .slice(0, 10);

  let catalog = [];
  try {
    catalog = await fetchSpecialsCatalog({ country, language, limit: 80 });
  } catch {
    catalog = [];
  }

  const seen = new Set();
  const dealsStrip = [];
  for (const event of events.slice(0, 8)) {
    dealsStrip.push({ kind: "event", ...event });
  }
  for (const item of [...specials, ...catalog]) {
    if (item.appId && seen.has(item.appId)) continue;
    if (item.appId) seen.add(item.appId);
    dealsStrip.push({
      kind: "game",
      ...item,
      headerImage: item.headerImage || item.image || "",
    });
  }

  return {
    events,
    specials: specials.slice(0, 12),
    newDeals: newDeals.slice(0, 10),
    bestDeals,
    dealsStrip,
  };
}

function portraitUrl(appId) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
}

async function searchSteamStore(term, { country = "br", language = "portuguese" } = {}) {
  const url = new URL("https://store.steampowered.com/api/storesearch/");
  url.searchParams.set("term", term);
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);
  const payload = await fetchJson(url);
  const items = payload?.items || [];
  if (!items.length) return null;
  const needle = String(term).toLowerCase().trim();
  const junk = /soundtrack|\bost\b|songs of the past|artwork|digital extra/i;
  const pool = items.filter((entry) => junk.test(needle) || !junk.test(entry.name));
  const list = pool.length ? pool : items;
  const item =
    list.find((entry) => String(entry.name).toLowerCase() === needle) ||
    [...list]
      .filter((entry) => String(entry.name).toLowerCase().startsWith(needle))
      .sort((a, b) => String(a.name).length - String(b.name).length)[0] ||
    list[0];
  if (!item?.id) return null;
  const cents = item.price?.final;
  return {
    appId: Number(item.id),
    steamName: item.name,
    currentPrice: cents != null ? centsToReais(cents) : null,
    discount: Number(item.price?.discount_percent || 0),
    tinyImage: item.tiny_image || "",
  };
}

module.exports = {
  resolveSteamId,
  fetchWishlist,
  fetchAppDetails,
  fetchPriceOverview,
  fetchReviews,
  fetchOwnedGames,
  fetchMostWanted,
  fetchSpecialsCatalog,
  fetchStoreHub,
  searchSteamStore,
  mapPool,
  capsuleUrl,
  portraitUrl,
};
