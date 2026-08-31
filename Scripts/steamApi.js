/**
 * Cliente das APIs públicas da Steam.
 * Wishlist precisa estar pública no perfil.
 */

const path = require("path");
const fs = require("fs/promises");
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

const SHORT_RETRY_MS = 1500;
const SHORT_RETRY_AFTER_CAP_MS = 2000;

function parseRetryAfterMs(header) {
  if (!header) return null;
  const trimmed = String(header).trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, SHORT_RETRY_AFTER_CAP_MS);
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.min(Math.max(0, when - Date.now()), SHORT_RETRY_AFTER_CAP_MS);
}

function isRateLimitError(error) {
  if (error?.status === 429) return true;
  return /\bHTTP 429\b/i.test(String(error?.message || error || ""));
}

function httpError(status, retryAfterMs) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
  return error;
}

async function fetchJson(url, { retries = 1, timeoutMs = 25000 } = {}) {
  const extraRetries = Math.max(0, Number(retries) || 0);
  const maxAttempts = extraRetries + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: STEAM_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        throw httpError(response.status, parseRetryAfterMs(response.headers.get("retry-after")));
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
      if (attempt >= maxAttempts) break;
      const is429 = error.status === 429 || isRateLimitError(error);
      const waitMs = is429 && error.retryAfterMs > 0 ? error.retryAfterMs : SHORT_RETRY_MS;
      await sleep(waitMs);
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

async function fetchAppDetails(appId, { country, language, retries = 0, timeoutMs = 8000 } = {}) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appId));
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);

  const payload = await fetchJson(url, { retries, timeoutMs });
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

  const payload = await fetchJson(url, { retries: 0, timeoutMs: 8000 });
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

function parseHoursValue(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (text.includes(",") && text.includes(".")) return Number(text.replace(/,/g, "")) || 0;
  if (text.includes(",") && !text.includes(".")) return Number(text.replace(",", ".")) || 0;
  return Number(text) || 0;
}

function xmlTag(block, tag) {
  const cdata = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"));
  if (cdata) return decodeHtml(cdata[1]);
  const plain = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return decodeHtml(plain?.[1] || "");
}

function communityLogoUrl(appId, hash) {
  if (!hash) return "";
  return `https://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${hash}.jpg`;
}

function parseOwnedGamesXml(xml) {
  const text = String(xml || "");
  if (!text.includes("<appID>")) {
    return { games: [], privateProfile: true };
  }
  const games = [];
  const seen = new Set();
  for (const chunk of text.split(/<game>/i).slice(1)) {
    const appId = Number(xmlTag(chunk, "appID"));
    if (!Number.isInteger(appId) || appId <= 0 || seen.has(appId)) continue;
    seen.add(appId);
    const hours = parseHoursValue(xmlTag(chunk, "hoursOnRecord"));
    games.push({
      appId,
      name: xmlTag(chunk, "name") || `App ${appId}`,
      logo: xmlTag(chunk, "logo"),
      hours,
      playtimeMinutes: Math.round(hours * 60),
    });
  }
  return { games, privateProfile: false };
}

async function fetchOwnedGamesFromXml(steamId64) {
  const xml = await fetchJson(
    `https://steamcommunity.com/profiles/${steamId64}/games?tab=all&xml=1`
  );
  return parseOwnedGamesXml(xml);
}

async function fetchOwnedGamesFromApi(steamId64, apiKey) {
  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", String(steamId64));
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("format", "json");
  const payload = await fetchJson(url);
  const list = payload?.response?.games;
  if (!Array.isArray(list) || !list.length) {
    return { games: [], privateProfile: true };
  }
  const games = list
    .map((item) => {
      const appId = Number(item.appid);
      const minutes = Number(item.playtime_forever || 0);
      return {
        appId,
        name: item.name || `App ${appId}`,
        logo: communityLogoUrl(appId, item.img_logo_url),
        hours: minutes / 60,
        playtimeMinutes: minutes,
      };
    })
    .filter((game) => Number.isInteger(game.appId) && game.appId > 0);
  return { games, privateProfile: false };
}

function steamId64ToAccountId(steamId64) {
  return (BigInt(String(steamId64)) - 76561197960265728n).toString();
}

function extractBraceBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i };
    }
  }
  return { body: text.slice(openIdx + 1), end: text.length };
}

function walkNumericBlocks(body) {
  const blocks = [];
  const re = /"(\d+)"\s*\{/g;
  let match;
  while ((match = re.exec(body))) {
    const brace = body.indexOf("{", match.index + match[0].length - 1);
    if (brace < 0) break;
    const extracted = extractBraceBody(body, brace);
    blocks.push({ id: Number(match[1]), inner: extracted.body });
    re.lastIndex = extracted.end + 1;
  }
  return blocks;
}

function parseLocalConfigPlaytimes(vdfText) {
  const text = String(vdfText || "");
  const appsAt = text.search(/"apps"\s*\{/i);
  if (appsAt < 0) return [];
  const brace = text.indexOf("{", appsAt);
  const { body } = extractBraceBody(text, brace);
  return walkNumericBlocks(body).map(({ id, inner }) => {
    const play = inner.match(/"Playtime"\s+"(\d+)"/i);
    const last = inner.match(/"LastPlayed"\s+"(\d+)"/i);
    const minutes = play ? Number(play[1]) : 0;
    return {
      appId: id,
      playtimeMinutes: minutes,
      hours: minutes / 60,
      lastPlayed: last ? Number(last[1]) : 0,
    };
  });
}

function parseAppManifestName(text) {
  const name = String(text || "").match(/"name"\s+"([^"]+)"/i);
  const appId = String(text || "").match(/"appid"\s+"(\d+)"/i);
  if (!appId) return null;
  return { appId: Number(appId[1]), name: name?.[1] || `App ${appId[1]}` };
}

function readCString(buf, offset, end) {
  let stop = offset;
  const limit = end == null ? buf.length : end;
  while (stop < limit && buf[stop] !== 0) stop += 1;
  return { value: buf.toString("utf8", offset, stop), next: stop + 1 };
}

function loadAppInfoStringTable(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x07564429) return null;
  const tableOff = Number(buf.readBigUInt64LE(8));
  if (tableOff < 16 || tableOff >= buf.length) return null;
  const count = buf.readUInt32LE(tableOff);
  const strings = [];
  let offset = tableOff + 4;
  for (let i = 0; i < count && offset < buf.length; i += 1) {
    const read = readCString(buf, offset);
    strings.push(read.value);
    offset = read.next;
  }
  return { strings, dataStart: 16, dataEnd: tableOff };
}

function nameFromAppInfoBlob(buf, start, end, strings) {
  let offset = start;
  let depth = 0;
  let inCommon = false;
  let commonDepth = 0;
  let name = "";
  let appType = "";

  while (offset < end) {
    const type = buf[offset];
    offset += 1;
    if (type === 0x08) {
      if (inCommon && depth === commonDepth) inCommon = false;
      depth -= 1;
      if (depth < 0) break;
      continue;
    }
    if (offset + 4 > end) break;
    const key = strings[buf.readUInt32LE(offset)] || "";
    offset += 4;
    if (type === 0x00) {
      depth += 1;
      if (key === "common") {
        inCommon = true;
        commonDepth = depth;
      }
    } else if (type === 0x01) {
      const read = readCString(buf, offset, end);
      offset = read.next;
      if (inCommon && depth === commonDepth) {
        if (key === "name" && !name) name = read.value;
        if (key === "type" && !appType) appType = read.value;
      }
    } else if (type === 0x02 || type === 0x03 || type === 0x04 || type === 0x06) {
      offset += 4;
    } else if (type === 0x07 || type === 0x0a) {
      offset += 8;
    } else if (type === 0x05) {
      while (offset + 1 < end && !(buf[offset] === 0 && buf[offset + 1] === 0)) offset += 2;
      offset += 2;
    } else {
      break;
    }
    if (name && appType && !inCommon) break;
  }
  return { name, appType };
}

function parseAppInfoNames(buf, wantedIds) {
  const table = loadAppInfoStringTable(buf);
  if (!table) return new Map();
  const names = new Map();
  const want = wantedIds instanceof Set ? wantedIds : null;
  let offset = table.dataStart;
  while (offset + 8 <= table.dataEnd) {
    const appId = buf.readUInt32LE(offset);
    const size = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (appId === 0) break;
    if (size < 60 || offset + size > table.dataEnd) break;
    const blobStart = offset + 60;
    const blobEnd = offset + size;
    offset = blobEnd;
    if (want && !want.has(appId)) continue;
    const info = nameFromAppInfoBlob(buf, blobStart, blobEnd, table.strings);
    if (info.name) names.set(appId, { name: info.name, appType: info.appType || "" });
  }
  return names;
}

function defaultSteamRoots() {
  const roots = [];
  if (process.env["ProgramFiles(x86)"]) {
    roots.push(pathJoin(process.env["ProgramFiles(x86)"], "Steam"));
  }
  if (process.env.ProgramFiles) {
    roots.push(pathJoin(process.env.ProgramFiles, "Steam"));
  }
  roots.push("C:\\Program Files (x86)\\Steam");
  return [...new Set(roots)];
}

function pathJoin(...parts) {
  return path.join(...parts);
}

async function readSteamFile(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function readSteamText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseLibraryFolderPaths(vdfText) {
  const paths = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let match;
  while ((match = re.exec(String(vdfText || "")))) {
    paths.push(match[1].replace(/\\\\/g, "\\"));
  }
  return paths;
}

async function collectAppManifestNames(steamRoot) {
  const names = new Map();
  const libraries = [steamRoot];
  const foldersText = await readSteamText(path.join(steamRoot, "steamapps", "libraryfolders.vdf"));
  for (const folder of parseLibraryFolderPaths(foldersText)) {
    if (folder && !libraries.includes(folder)) libraries.push(folder);
  }
  for (const library of libraries) {
    const appsDir = path.join(library, "steamapps");
    let files = [];
    try {
      files = await fs.readdir(appsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
      const parsed = parseAppManifestName(await readSteamText(path.join(appsDir, file)));
      if (parsed?.appId) names.set(parsed.appId, parsed.name);
    }
  }
  return names;
}

async function fetchOwnedGamesFromLocal(steamId64) {
  const accountId = steamId64ToAccountId(steamId64);
  let steamRoot = "";
  let vdfText = "";
  for (const root of defaultSteamRoots()) {
    const candidate = path.join(root, "userdata", accountId, "config", "localconfig.vdf");
    vdfText = await readSteamText(candidate);
    if (vdfText) {
      steamRoot = root;
      break;
    }
  }
  if (!vdfText) {
    return { games: [], privateProfile: true, localAvailable: false };
  }

  const playtimes = parseLocalConfigPlaytimes(vdfText);
  const manifestNames = await collectAppManifestNames(steamRoot);
  const meta = new Map();
  const appinfoBuf = await readSteamFile(path.join(steamRoot, "appcache", "appinfo.vdf"));
  if (appinfoBuf) {
    const fromInfo = parseAppInfoNames(appinfoBuf, new Set(playtimes.map((item) => item.appId)));
    for (const [appId, info] of fromInfo) meta.set(appId, info);
  }

  const games = playtimes
    .filter((item) => Number.isInteger(item.appId) && item.appId > 0)
    .map((item) => {
      const info = meta.get(item.appId);
      return {
        appId: item.appId,
        name: info?.name || manifestNames.get(item.appId) || `App ${item.appId}`,
        logo: "",
        hours: item.hours,
        playtimeMinutes: item.playtimeMinutes,
        appType: info?.appType || "",
      };
    });

  return { games, privateProfile: true, localAvailable: true };
}

async function fetchOwnedPlaytimes(steamId64, { apiKey } = {}) {
  try {
    const xml = await fetchOwnedGamesFromXml(steamId64);
    if (xml.games.length) {
      return { ...xml, source: "xml", communityPrivate: false };
    }
  } catch {
    // perfil privado, sign-in wall ou XML vazio
  }

  if (apiKey) {
    try {
      const api = await fetchOwnedGamesFromApi(steamId64, apiKey);
      if (api.games.length) {
        return { ...api, source: "api", communityPrivate: false };
      }
    } catch {
      // chave inválida ou perfil ainda privado
    }
  }

  const local = await fetchOwnedGamesFromLocal(steamId64);
  if (local.games.length) {
    return {
      games: local.games,
      source: "local",
      communityPrivate: true,
      localAvailable: true,
    };
  }

  return {
    games: [],
    source: "none",
    communityPrivate: true,
    localAvailable: Boolean(local.localAvailable),
  };
}

async function fetchOwnedGames(steamId64) {
  const owned = await fetchOwnedPlaytimes(steamId64);
  return {
    ids: new Set(owned.games.map((game) => game.appId)),
    privateProfile: owned.communityPrivate && owned.source !== "local",
    games: owned.games,
    source: owned.source,
  };
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
  fetchOwnedPlaytimes,
  fetchMostWanted,
  fetchSpecialsCatalog,
  fetchStoreHub,
  searchSteamStore,
  mapPool,
  capsuleUrl,
  portraitUrl,
  isRateLimitError,
};
