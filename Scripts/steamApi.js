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

function isForbiddenError(error) {
  if (error?.status === 403) return true;
  return /\bHTTP 403\b/i.test(String(error?.message || error || ""));
}

function httpError(status, retryAfterMs) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
  return error;
}

function shouldRetryHttp(error, attempt, maxAttempts) {
  if (attempt >= maxAttempts) return false;
  const status = Number(error?.status) || 0;
  if (status === 403 || status === 404) return false;
  if (status >= 400 && status < 500 && status !== 429) return false;
  return status === 429 || status >= 500 || status === 0;
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
      if (!response.ok) {
        throw httpError(response.status, parseRetryAfterMs(response.headers.get("retry-after")));
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("xml") || contentType.includes("html")) {
        return await response.text();
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (!shouldRetryHttp(error, attempt, maxAttempts)) break;
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
    releaseDate: String(data?.release_date?.date || "").trim(),
    earlyAccess: [...genres, ...categories].some((tag) => /early access|acesso antecipado/i.test(tag)),
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
      comingSoon: undefined,
      releaseDate: "",
      earlyAccess: false,
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
  const release = data.release_date;
  if (!entry?.success) {
    return { appId, currentPrice: null, initialPrice: null, discount: 0, unavailable: true };
  }
  return {
    appId,
    currentPrice: isFree ? 0 : centsToReais(overview?.final),
    initialPrice: isFree ? 0 : centsToReais(overview?.initial),
    discount: isFree ? 0 : Number(overview?.discount_percent || 0),
    isFree,
    comingSoon: release ? Boolean(release.coming_soon) : undefined,
    releaseDate: release?.date ? String(release.date).trim() : undefined,
    unavailable: !overview && !isFree,
  };
}

function firstLocalized(list) {
  if (!Array.isArray(list)) return "";
  return list.find((item) => typeof item === "string" && item.trim()) || "";
}

function partnerEventImage(event) {
  let json = {};
  try {
    json = JSON.parse(event?.jsondata || "{}");
  } catch {
    json = {};
  }
  const file =
    firstLocalized(json.localized_capsule_image) || firstLocalized(json.localized_title_image);
  const clanId = event?.announcement_body?.clanid;
  if (!file || !clanId) return "";
  return `https://clan.akamai.steamstatic.com/images/${clanId}/${file}`;
}

async function fetchAppNews(appId, { count = 5 } = {}) {
  const url = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
  url.searchParams.set("appid", String(appId));
  url.searchParams.set("count", String(count));
  url.searchParams.set("maxlength", "240");
  url.searchParams.set("format", "json");
  url.searchParams.set("feeds", "steam_community_announcements");
  const payload = await fetchJson(url, { retries: 0, timeoutMs: 8000 });
  return Array.isArray(payload?.appnews?.newsitems) ? payload.appnews.newsitems : [];
}

async function fetchPartnerEvents(appId, { language = "brazilian", count = 8 } = {}) {
  const lang = language === "portuguese" ? "brazilian" : language || "brazilian";
  const url = new URL("https://store.steampowered.com/events/ajaxgetadjacentpartnerevents/");
  url.searchParams.set("appid", String(appId));
  url.searchParams.set("count_before", "0");
  url.searchParams.set("count_after", String(count));
  url.searchParams.set("l", lang);
  const payload = await fetchJson(url, { retries: 0, timeoutMs: 8000 });
  return Array.isArray(payload?.events) ? payload.events : [];
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

function mapOwnedApiGames(list) {
  return (list || [])
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
}

async function fetchOwnedGamesFromApi(steamId64, apiKey) {
  const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", String(steamId64));
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("include_free_sub", "1");
  url.searchParams.set("format", "json");
  let payload;
  try {
    payload = await fetchJson(url);
  } catch {
    url.searchParams.delete("include_free_sub");
    payload = await fetchJson(url);
  }
  const list = payload?.response?.games;
  if (!Array.isArray(list) || !list.length) {
    return { games: [], privateProfile: true };
  }
  return { games: mapOwnedApiGames(list), privateProfile: false };
}

function steamId64ToAccountId(steamId64) {
  return (BigInt(String(steamId64)) - 76561197960265728n).toString();
}

function accountIdToSteamId64(accountId) {
  return (BigInt(String(accountId)) + 76561197960265728n).toString();
}

function isBareAppName(name) {
  return /^App \d+$/i.test(String(name || "").trim());
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

const CACHE_SKIP_TYPES = new Set([
  "config",
  "tool",
  "demo",
  "dlc",
  "music",
  "video",
  "hardware",
  "series",
  "advertising",
]);

async function findSteamRootForAccount(accountId) {
  for (const root of defaultSteamRoots()) {
    const localConfig = await readSteamText(
      path.join(root, "userdata", String(accountId), "config", "localconfig.vdf")
    );
    if (localConfig) return { steamRoot: root, localConfig };
  }
  return { steamRoot: "", localConfig: "" };
}

async function loadAppInfoMeta(steamRoot, wantedIds) {
  const meta = new Map();
  const manifestNames = steamRoot ? await collectAppManifestNames(steamRoot) : new Map();
  for (const [appId, name] of manifestNames) {
    meta.set(appId, { name, appType: "" });
  }
  if (!steamRoot) return meta;
  const appinfoBuf = await readSteamFile(path.join(steamRoot, "appcache", "appinfo.vdf"));
  if (!appinfoBuf) return meta;
  const fromInfo = parseAppInfoNames(appinfoBuf, wantedIds instanceof Set ? wantedIds : null);
  for (const [appId, info] of fromInfo) {
    const prev = meta.get(appId);
    meta.set(appId, {
      name: info.name || prev?.name || "",
      appType: info.appType || prev?.appType || "",
    });
  }
  return meta;
}

function namedGameFromMeta(appId, meta, extras = {}) {
  if (appId === 7 || appId === 228980 || appId === 250820) return null;
  const info = meta.get(appId);
  const name = info?.name || extras.name || "";
  if (!name || isBareAppName(name)) return null;
  const appType = String(info?.appType || extras.appType || "").toLowerCase();
  if (CACHE_SKIP_TYPES.has(appType)) return null;
  return {
    appId,
    name,
    logo: extras.logo || "",
    hours: extras.hours != null ? Number(extras.hours) : 0,
    playtimeMinutes:
      extras.playtimeMinutes != null ? Number(extras.playtimeMinutes) : Math.round((extras.hours || 0) * 60),
    appType: info?.appType || extras.appType || "",
    family: Boolean(extras.family),
  };
}

function parseFamilyGroupFromVdf(vdfText) {
  const text = String(vdfText || "");
  const at = text.search(/"FamilyGroup"\s*\{/i);
  if (at < 0) return null;
  const brace = text.indexOf("{", at);
  const { body } = extractBraceBody(text, brace);
  const groupid = body.match(/"groupid"\s+"(\d+)"/i)?.[1] || "";
  const name = body.match(/"name"\s+"([^"]*)"/i)?.[1] || "";
  const members = [];
  const seen = new Set();
  for (const match of body.matchAll(/"accountid"\s+"(\d+)"/gi)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    members.push(id);
  }
  if (!groupid && !members.length) return null;
  return { groupid, name, members };
}

function addNumericId(set, value) {
  const appId = Number(value);
  if (Number.isInteger(appId) && appId > 0) set.add(appId);
}

async function collectLibraryCacheAppIds(steamRoot, accountId) {
  const ids = new Set();
  const userCache = path.join(steamRoot, "userdata", String(accountId), "config", "librarycache");
  try {
    for (const file of await fs.readdir(userCache)) {
      const match = file.match(/^(\d+)\.json$/i);
      if (match) addNumericId(ids, match[1]);
    }
  } catch {
    // pasta ainda não existe
  }
  const artCache = path.join(steamRoot, "appcache", "librarycache");
  try {
    for (const entry of await fs.readdir(artCache, { withFileTypes: true })) {
      if (/^\d+$/.test(entry.name)) addNumericId(ids, entry.name);
    }
  } catch {
    // cache de capas ausente
  }
  const cloud = path.join(
    steamRoot,
    "userdata",
    String(accountId),
    "config",
    "cloudstorage",
    "cloud-storage-namespace-1.json"
  );
  const cloudText = await readSteamText(cloud);
  if (cloudText) {
    try {
      const rows = JSON.parse(cloudText);
      for (const pair of Array.isArray(rows) ? rows : []) {
        const key = String(pair?.[0] || "");
        const rec = pair?.[1] || {};
        const rollup = key.match(/^NewContentRollup_(\d+)$/i);
        if (rollup) addNumericId(ids, rollup[1]);
        if (!/user-collections/i.test(key) || rec.is_deleted) continue;
        let added = [];
        try {
          const value = typeof rec.value === "string" ? JSON.parse(rec.value) : rec.value;
          added = value?.added || [];
        } catch {
          added = [];
        }
        for (const appId of added) addNumericId(ids, appId);
      }
    } catch {
      // json de coleções ilegível
    }
  }
  return ids;
}

function parseSharingLogAppIds(text) {
  const ids = new Set();
  for (const match of String(text || "").matchAll(/\bapp\s+(\d+)\b/gi)) {
    addNumericId(ids, match[1]);
  }
  return ids;
}

function mergeOwnedGame(map, game, { family = false, source = "" } = {}) {
  const appId = Number(game?.appId);
  if (!Number.isInteger(appId) || appId <= 0) return;
  const hours =
    game.hours != null && Number.isFinite(Number(game.hours))
      ? Number(game.hours)
      : Number(game.playtimeMinutes || 0) / 60;
  const existing = map.get(appId);
  if (!existing) {
    map.set(appId, {
      appId,
      name: game.name || `App ${appId}`,
      logo: game.logo || "",
      hours: hours || 0,
      playtimeMinutes: game.playtimeMinutes != null ? Number(game.playtimeMinutes) : Math.round((hours || 0) * 60),
      appType: game.appType || "",
      family: Boolean(family || game.family),
      source: source || game.source || "",
    });
    return;
  }
  if (game.name && !isBareAppName(game.name)) existing.name = game.name;
  if ((hours || 0) > (existing.hours || 0)) {
    existing.hours = hours;
    existing.playtimeMinutes = Math.round(hours * 60);
  }
  if (game.logo && !existing.logo) existing.logo = game.logo;
  if (game.appType && !existing.appType) existing.appType = game.appType;
  if (family || game.family) {
    if (!existing.source || existing.source === "family") existing.family = true;
  }
  if (source && source !== "family" && !existing.family) existing.source = source;
}

async function collectNamedCacheGames(steamRoot, accountId, meta) {
  const ids = await collectLibraryCacheAppIds(steamRoot, accountId);
  const games = [];
  for (const appId of ids) {
    const game = namedGameFromMeta(appId, meta);
    if (game) games.push(game);
  }
  return games;
}

async function fetchFamilyGroupFromApi(steamId64, apiKey) {
  const url = new URL("https://api.steampowered.com/IFamilyGroupsService/GetFamilyGroupForUser/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", String(steamId64));
  url.searchParams.set("include_family_group_response", "1");
  const payload = await fetchJson(url, { retries: 0, timeoutMs: 12000 });
  const res = payload?.response || {};
  const groupid = String(res.family_groupid || res.familyGroupid || "");
  const group = res.family_group || res.familyGroup || {};
  const members = [];
  for (const member of group.members || []) {
    if (member.steamid) members.push(String(member.steamid));
    else if (member.accountid != null) members.push(accountIdToSteamId64(member.accountid));
  }
  return {
    groupid,
    name: group.name || "",
    members,
  };
}

function mapSharedLibraryApps(apps, steamId64) {
  const games = [];
  for (const item of apps || []) {
    const appId = Number(item.appid ?? item.appId);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    const owners = (item.owner_steamids || item.ownerSteamids || []).map(String);
    const family = owners.length ? !owners.includes(String(steamId64)) : true;
    const minutes = Number(item.playtime?.playtime_forever ?? item.playtime_forever ?? 0);
    games.push({
      appId,
      name: item.name || `App ${appId}`,
      logo: "",
      hours: minutes / 60,
      playtimeMinutes: minutes,
      appType: item.app_type || item.type || "",
      family,
    });
  }
  return games;
}

async function fetchSharedLibraryApps(familyGroupId, apiKey, steamId64) {
  const url = new URL("https://api.steampowered.com/IFamilyGroupsService/GetSharedLibraryApps/v1/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("family_groupid", String(familyGroupId));
  url.searchParams.set("include_own", "1");
  url.searchParams.set("include_excluded", "0");
  url.searchParams.set("include_free", "1");
  url.searchParams.set("include_non_games", "0");
  url.searchParams.set("language", "english");
  url.searchParams.set("max_apps", "10000");
  url.searchParams.set("steamid", String(steamId64));
  const payload = await fetchJson(url, { retries: 0, timeoutMs: 20000 });
  return mapSharedLibraryApps(payload?.response?.apps, steamId64);
}

async function fetchOwnedGamesFromLocal(steamId64) {
  const accountId = steamId64ToAccountId(steamId64);
  const { steamRoot, localConfig } = await findSteamRootForAccount(accountId);
  if (!localConfig) {
    return { games: [], privateProfile: true, localAvailable: false, steamRoot: "", localConfig: "" };
  }

  const playtimes = parseLocalConfigPlaytimes(localConfig);
  const wanted = new Set(playtimes.map((item) => item.appId));
  const meta = await loadAppInfoMeta(steamRoot, wanted);

  const games = playtimes
    .filter((item) => Number.isInteger(item.appId) && item.appId > 0)
    .map((item) => {
      const info = meta.get(item.appId);
      return {
        appId: item.appId,
        name: info?.name || `App ${item.appId}`,
        logo: "",
        hours: item.hours,
        playtimeMinutes: item.playtimeMinutes,
        appType: info?.appType || "",
      };
    });

  return { games, privateProfile: true, localAvailable: true, steamRoot, localConfig, meta };
}

async function fetchFamilySharedGames(steamId64, { apiKey, steamRoot, localConfig, meta } = {}) {
  const accountId = steamId64ToAccountId(steamId64);
  const localGroup = parseFamilyGroupFromVdf(localConfig || "");
  let apiGroup = null;
  let sharedFromApi = [];
  if (apiKey) {
    try {
      apiGroup = await fetchFamilyGroupFromApi(steamId64, apiKey);
    } catch {
      apiGroup = null;
    }
    const groupid = apiGroup?.groupid || localGroup?.groupid;
    if (groupid) {
      try {
        sharedFromApi = await fetchSharedLibraryApps(groupid, apiKey, steamId64);
      } catch {
        sharedFromApi = [];
      }
    }
  }

  const found = Boolean(localGroup || apiGroup?.groupid);
  const gamesById = new Map();
  const nameMeta = meta || (steamRoot ? await loadAppInfoMeta(steamRoot, null) : new Map());

  for (const game of sharedFromApi) {
    const named = namedGameFromMeta(game.appId, nameMeta, game) || (isBareAppName(game.name) ? null : game);
    if (named) mergeOwnedGame(gamesById, { ...named, family: true }, { family: true, source: "family" });
  }

  const sharingLog = steamRoot ? await readSteamText(path.join(steamRoot, "logs", "librarysharing_log.txt")) : "";
  for (const appId of parseSharingLogAppIds(sharingLog)) {
    const named = namedGameFromMeta(appId, nameMeta, { family: true });
    if (named) mergeOwnedGame(gamesById, named, { family: true, source: "family" });
  }

  const memberIds = new Set();
  if (localGroup) {
    for (const id of localGroup.members) {
      if (String(id) === String(accountId)) continue;
      memberIds.add(accountIdToSteamId64(id));
    }
  }
  for (const id of apiGroup?.members || []) {
    if (String(id) === String(steamId64) || String(id) === String(accountId)) continue;
    memberIds.add(/^\d{17}$/.test(String(id)) ? String(id) : accountIdToSteamId64(id));
  }

  let memberLibraries = 0;
  for (const memberSteamId of memberIds) {
    try {
      const xml = await fetchOwnedGamesFromXml(memberSteamId);
      if (xml.games.length) {
        memberLibraries += 1;
        for (const game of xml.games) {
          mergeOwnedGame(gamesById, { ...game, hours: 0, playtimeMinutes: 0, family: true }, { family: true, source: "family" });
        }
      }
    } catch {
      // perfil do membro privado
    }
    if (apiKey) {
      try {
        const api = await fetchOwnedGamesFromApi(memberSteamId, apiKey);
        if (api.games.length) {
          memberLibraries += 1;
          for (const game of api.games) {
            mergeOwnedGame(
              gamesById,
              { ...game, hours: 0, playtimeMinutes: 0, family: true },
              { family: true, source: "family" }
            );
          }
        }
      } catch {
        // chave sem acesso à biblioteca do membro
      }
    }
  }

  const complete = sharedFromApi.length > 0 || memberLibraries > 0;
  return {
    games: [...gamesById.values()].map((game) => ({ ...game, family: true, hours: game.hours || 0 })),
    found,
    complete,
    groupName: apiGroup?.name || localGroup?.name || "",
    groupid: apiGroup?.groupid || localGroup?.groupid || "",
    memberCount: (localGroup?.members?.length || memberIds.size + (found ? 1 : 0)) || 0,
  };
}

async function fetchOwnedPlaytimes(steamId64, { apiKey } = {}) {
  const owned = new Map();
  const used = [];
  let xmlOk = false;
  let apiOk = false;

  const local = await fetchOwnedGamesFromLocal(steamId64);
  if (local.games.length) {
    used.push("local");
    for (const game of local.games) mergeOwnedGame(owned, game, { source: "local" });
  }

  try {
    const xml = await fetchOwnedGamesFromXml(steamId64);
    if (xml.games.length) {
      xmlOk = true;
      used.push("xml");
      for (const game of xml.games) mergeOwnedGame(owned, game, { source: "xml" });
    }
  } catch {
    // perfil privado, sign-in wall ou XML vazio
  }

  if (apiKey) {
    try {
      const api = await fetchOwnedGamesFromApi(steamId64, apiKey);
      if (api.games.length) {
        apiOk = true;
        used.push("api");
        for (const game of api.games) mergeOwnedGame(owned, game, { source: "api" });
      }
    } catch {
      // chave inválida ou perfil ainda privado
    }
  }

  let cacheCount = 0;
  if (local.steamRoot) {
    const wanted = new Set(owned.keys());
    const cacheIds = await collectLibraryCacheAppIds(local.steamRoot, steamId64ToAccountId(steamId64));
    for (const id of cacheIds) wanted.add(id);
    const sharingLog = await readSteamText(path.join(local.steamRoot, "logs", "librarysharing_log.txt"));
    for (const id of parseSharingLogAppIds(sharingLog)) wanted.add(id);
    const meta = await loadAppInfoMeta(local.steamRoot, wanted);
    local.meta = meta;
    const cacheGames = await collectNamedCacheGames(local.steamRoot, steamId64ToAccountId(steamId64), meta);
    cacheCount = cacheGames.filter((game) => !owned.has(game.appId)).length;
    if (cacheGames.length) {
      used.push("cache");
      for (const game of cacheGames) mergeOwnedGame(owned, game, { source: "cache" });
    }
  }

  const family = await fetchFamilySharedGames(steamId64, {
    apiKey,
    steamRoot: local.steamRoot,
    localConfig: local.localConfig,
    meta: local.meta,
  });
  let familyAdded = 0;
  if (family.games.length) {
    used.push("family");
    for (const game of family.games) {
      if (!owned.has(game.appId)) familyAdded += 1;
      const already = owned.get(game.appId);
      if (already) {
        mergeOwnedGame(owned, { ...game, hours: already.hours, playtimeMinutes: already.playtimeMinutes, family: false });
      } else {
        mergeOwnedGame(owned, { ...game, hours: 0, playtimeMinutes: 0 }, { family: true, source: "family" });
      }
    }
  }

  const games = [...owned.values()].map((game) => ({
    appId: game.appId,
    name: game.name,
    logo: game.logo,
    hours: game.hours || 0,
    playtimeMinutes: game.playtimeMinutes || 0,
    appType: game.appType || "",
    family: Boolean(game.family),
  }));

  let source = "none";
  if (apiOk) source = "api";
  else if (xmlOk) source = "xml";
  else if (local.games.length || cacheCount) source = "local";

  return {
    games,
    source,
    communityPrivate: !xmlOk && !apiOk,
    localAvailable: Boolean(local.localAvailable),
    familyFound: family.found,
    familyComplete: family.complete,
    familyCount: familyAdded,
    familyGroupName: family.groupName,
    cacheExtra: cacheCount,
    sources: used,
  };
}

async function fetchOwnedGames(steamId64, { apiKey } = {}) {
  const owned = await fetchOwnedPlaytimes(steamId64, { apiKey });
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
    newDeals: [],
    bestDeals: [],
    dealsStrip,
  };
}

function portraitUrl(appId) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
}

async function searchSteamStore(term, { country = "br", language = "portuguese", timeoutMs = 4000 } = {}) {
  const url = new URL("https://store.steampowered.com/api/storesearch/");
  url.searchParams.set("term", term);
  url.searchParams.set("cc", country);
  url.searchParams.set("l", language);
  const payload = await fetchJson(url, { retries: 0, timeoutMs });
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
  fetchPartnerEvents,
  fetchAppNews,
  partnerEventImage,
  mapPool,
  capsuleUrl,
  portraitUrl,
  isRateLimitError,
  isForbiddenError,
};
