/**
 * Biblioteca da Epic Games Store.
 * Sem API pública oficial da conta: o login usa o mesmo client do launcher
 * (Heroic / Legendary). Jogos instalados saem dos manifests locais, mesmo sem login.
 */

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { readJson, writeJson, nowIso, sleep } = require("./config");

const EPIC_APP_BASE = 2100000000;
const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const OAUTH_HOST = "account-public-service-prod03.ol.epicgames.com";
const LIBRARY_HOST = "library-service.live.use1a.on.epicgames.com";
const CATALOG_HOST = "catalog-public-service-prod06.ol.epicgames.com";
const LAUNCHER_HOST = "launcher-public-service-prod06.ol.epicgames.com";
const USER_AGENT = "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";
const EGL_DATA_KEYS = ["A09C853C9E95409BB94D707EADEFA52E"];
const JUNK_TITLE =
  /unreal engine|^ue[_\s.-]?\d|epic online services|twinmotion|metahuman|quixel|^bridge\b|fab library|unrealeditor/i;
const CATALOG_CHUNK = 40;
const CATALOG_CONCURRENCY = 3;
const CATALOG_DELAY_MS = 120;
const HEX_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEpicPlaceholderName(name) {
  const text = String(name || "").trim();
  if (!text) return true;
  if (HEX_ID_RE.test(text) || UUID_RE.test(text)) return true;
  if (text.length >= 16 && /^[0-9a-f]+$/i.test(text)) return true;
  if (text.length >= 12 && /^[0-9a-f-]+$/i.test(text)) {
    const hex = (text.match(/[0-9a-f]/gi) || []).length;
    if (hex / text.replace(/-/g, "").length >= 0.9) return true;
  }
  return false;
}

function isRealEpicTitle(name) {
  return !isEpicPlaceholderName(name);
}

function displayTitle(...candidates) {
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (isRealEpicTitle(text)) return text;
  }
  return "";
}

function isEpicAppId(appId) {
  return Number(appId) >= EPIC_APP_BASE;
}

function isEpicGame(game) {
  return game?.store === "epic" || isEpicAppId(game?.appId);
}

function epicAuthUrl() {
  const redirect = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirect)}`;
}

function fnv1a(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function epicAppIdFor(catalogItemId, used) {
  let id = EPIC_APP_BASE + (fnv1a(String(catalogItemId).toLowerCase()) % 800000000);
  while (used.has(id)) id += 1;
  used.add(id);
  return id;
}

function basicAuth() {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

async function epicFetch(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { "User-Agent": USER_AGENT, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const code = json?.errorCode || json?.errorMessage || `HTTP ${response.status}`;
    const error = new Error(String(code));
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

function manifestsDir() {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return path.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
}

function collectKeyImages(meta) {
  if (!meta || typeof meta !== "object") return [];
  const out = [];
  const push = (images) => {
    if (Array.isArray(images)) out.push(...images);
  };
  push(meta.keyImages);
  push(meta.offer?.keyImages);
  if (Array.isArray(meta.offers)) {
    for (const offer of meta.offers) push(offer?.keyImages);
  }
  return out;
}

function pickCover(images) {
  if (!Array.isArray(images) || !images.length) return "";
  const rank = [
    "DieselGameBoxWide",
    "OfferImageWide",
    "DieselGameBox",
    "OfferImageTall",
    "DieselGameBoxTall",
    "Thumbnail",
    "ProductThumbnail",
    "featuredMedia",
    "Takeover",
  ];
  for (const type of rank) {
    const hit = images.find((item) => String(item?.type || "") === type && item?.url);
    if (hit?.url) return hit.url;
  }
  const any = images.find((item) => item?.url);
  return any?.url || "";
}

function epicCoverFallbacks({ namespace, catalogItemId } = {}) {
  const ns = String(namespace || "").trim();
  const id = String(catalogItemId || "").trim();
  if (!ns || !id) return [];
  return [
    `https://cdn1.epicgames.com/offer/${ns}/${id}`,
    `https://cdn1.epicgames.com/item/${ns}/${id}`,
    `https://cdn1.epicgames.com/${ns}/offer/${id}`,
    `https://cdn1.epicgames.com/${ns}/item/${id}`,
  ];
}

function catalogCover(meta, draft = {}) {
  return (
    pickCover(collectKeyImages(meta)) ||
    pickCover(draft.keyImages) ||
    String(draft.cover || "").trim() ||
    ""
  );
}

function productSlug(meta = {}) {
  const attrs = meta.customAttributes && typeof meta.customAttributes === "object" ? meta.customAttributes : {};
  const raw =
    attrs["com.epicgames.app.productSlug"]?.value ||
    attrs.productSlug?.value ||
    meta.productSlug ||
    "";
  return String(raw).split("/")[0].trim();
}

function storeUrlFor(meta, name) {
  const slug = productSlug(meta);
  if (slug) return `https://store.epicgames.com/pt-BR/p/${encodeURIComponent(slug)}`;
  const q = String(name || "").trim();
  return q ? `https://store.epicgames.com/pt-BR/browse?q=${encodeURIComponent(q)}` : "https://store.epicgames.com/pt-BR/";
}

function categoryPaths(meta) {
  return (meta?.categories || []).map((item) => String(item.path || item).toLowerCase());
}

function isEpicJunk(name, meta, item = {}) {
  const title = String(name || meta?.title || item.DisplayName || "");
  if (JUNK_TITLE.test(title)) return true;
  if (item.bIsFab) return true;
  const cats = categoryPaths(meta);
  if (cats.some((cat) => cat.includes("engines") || cat.includes("software/editors"))) return true;
  if (meta?.mainGameItem) return true;
  const appCats = Array.isArray(item.AppCategories) ? item.AppCategories.map((cat) => String(cat).toLowerCase()) : [];
  if (appCats.includes("engines") && !appCats.includes("games")) return true;
  return false;
}

function toOwnedRow({ appId, name, cover, storeUrl, catalogItemId, namespace, appName }) {
  return {
    appId,
    name,
    logo: "",
    hours: 0,
    playtimeMinutes: 0,
    appType: "game",
    family: false,
    store: "epic",
    storeUrl,
    cover,
    coverUrl: cover,
    epicId: catalogItemId,
    epicNamespace: namespace,
    epicAppName: appName,
  };
}

async function readInstalledEpicGames() {
  const dir = manifestsDir();
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    if (!/\.item$/i.test(file)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
      const catalogItemId = String(raw.CatalogItemId || "").trim();
      const name = String(raw.DisplayName || "").trim();
      if (!catalogItemId || !name) continue;
      if (isEpicJunk(name, {}, raw)) continue;
      const cats = Array.isArray(raw.AppCategories) ? raw.AppCategories.map((cat) => String(cat).toLowerCase()) : [];
      if (cats.length && !cats.includes("games") && !cats.includes("applications")) continue;
      rows.push({
        catalogItemId,
        namespace: String(raw.CatalogNamespace || ""),
        appName: String(raw.AppName || ""),
        name,
        cover: String(raw.VaultThumbnailUrl || ""),
        storeUrl: storeUrlFor({}, name),
      });
    } catch {
      // manifesto quebrado não derruba o resto
    }
  }
  return rows;
}

async function startEpicSession({ refreshToken, authorizationCode } = {}) {
  const params = new URLSearchParams({ token_type: "eg1" });
  if (refreshToken) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
  } else if (authorizationCode) {
    params.set("grant_type", "authorization_code");
    params.set("code", authorizationCode);
  } else {
    throw new Error("Falta código ou token da Epic.");
  }
  return epicFetch(`https://${OAUTH_HOST}/account/api/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
}

function eglConfigPaths() {
  const local = process.env.LOCALAPPDATA || "";
  if (!local) return [];
  return ["Windows", "WindowsClient", "WindowsEditor"].map((folder) =>
    path.join(local, "EpicGamesLauncher", "Saved", "Config", folder, "GameUserSettings.ini")
  );
}

function parseIniSection(text, section) {
  const match = String(text || "").match(new RegExp(`\\[${section}\\]([^\\[]*)`, "i"));
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const hit = line.match(/^([^=]+)=(.*)$/);
    if (hit) out[hit[1].trim()] = hit[2];
  }
  return out;
}

function decryptEpicData(raw, keys = EGL_DATA_KEYS) {
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-ecb", Buffer.from(key, "ascii"), null);
      decipher.setAutoPadding(true);
      const plain = Buffer.concat([decipher.update(raw), decipher.final()]).toString("utf8").replace(/\0+$/g, "");
      const json = JSON.parse(plain);
      return { json, key, plain };
    } catch {
      // próxima chave
    }
  }
  throw new Error("Não deu para ler a sessão salva do launcher da Epic.");
}

function encryptEpicData(plain, key) {
  const cipher = crypto.createCipheriv("aes-256-ecb", Buffer.from(key, "ascii"), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("base64");
}

function readEglRememberMe() {
  for (const file of eglConfigPaths()) {
    if (!fsSync.existsSync(file)) continue;
    let text = "";
    try {
      text = fsSync.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const remember = parseIniSection(text, "RememberMe");
    if (!remember.Data || !/^true$/i.test(String(remember.Enable || ""))) continue;
    try {
      const raw = Buffer.from(remember.Data, "base64");
      const payload = raw[0] === 0x7b ? { json: JSON.parse(raw.toString("utf8")), key: "", plain: raw.toString("utf8") } : decryptEpicData(raw);
      const row = Array.isArray(payload.json) ? payload.json[0] : payload.json;
      const token = String(row?.Token || "").trim();
      if (!token) continue;
      return {
        file,
        text,
        key: payload.key,
        plain: payload.plain,
        json: payload.json,
        row,
        token,
        displayName: String(row.DisplayName || row.Name || "").trim(),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function probeEglSession() {
  const hit = readEglRememberMe();
  if (!hit) return { available: false, displayName: "" };
  return { available: true, displayName: hit.displayName };
}

function writeRememberMeToken(hit, refreshToken) {
  if (!hit?.file || !refreshToken) return false;
  const nextJson = Array.isArray(hit.json) ? [...hit.json] : [hit.json];
  const first = { ...(nextJson[0] || {}) };
  first.Token = refreshToken;
  nextJson[0] = first;
  const plain = JSON.stringify(nextJson);
  const encoded = hit.key ? encryptEpicData(plain, hit.key) : Buffer.from(plain, "utf8").toString("base64");
  const updated = hit.text.replace(/(\[RememberMe\][\s\S]*?^Data=).*/m, `$1${encoded}`);
  if (updated === hit.text) return false;
  fsSync.writeFileSync(hit.file, updated, "utf8");
  return true;
}

async function importEglSession() {
  const hit = readEglRememberMe();
  if (!hit) {
    throw new Error("O launcher da Epic neste PC não tem uma sessão salva. Entre no site da Epic.");
  }
  const session = await startEpicSession({ refreshToken: hit.token });
  try {
    writeRememberMeToken(hit, session.refresh_token || hit.token);
  } catch {
    // o nosso token já vale; o launcher pode pedir login de novo
  }
  return session;
}

async function fetchLibraryRecords(accessToken) {
  const records = [];
  let cursor = "";
  for (let i = 0; i < 30; i += 1) {
    const url = new URL(`https://${LIBRARY_HOST}/library/api/public/items`);
    url.searchParams.set("includeMetadata", "true");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await epicFetch(url, {
      headers: { Authorization: `bearer ${accessToken}` },
    });
    records.push(...(payload?.records || []));
    cursor = payload?.responseMetadata?.nextCursor || "";
    if (!cursor) break;
  }
  return records;
}

async function exchangeSidForCode(sid) {
  const rawSid = String(sid || "").trim();
  if (!rawSid) throw new Error("Falta sid da Epic.");
  const setRes = await fetch(`https://www.epicgames.com/id/api/set-sid?sid=${encodeURIComponent(rawSid)}`, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const parts = [`sid=${rawSid}`, `SID=${rawSid}`];
  const setCookie = typeof setRes.headers.getSetCookie === "function" ? setRes.headers.getSetCookie() : [];
  for (const cookie of setCookie) {
    const pair = String(cookie).split(";")[0];
    if (pair) parts.push(pair);
  }
  const json = await epicFetch(`https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`, {
    headers: {
      Cookie: parts.join("; "),
      Accept: "application/json,text/plain,*/*",
    },
  });
  const code = String(json?.authorizationCode || json?.authorization_code || "").trim();
  if (!code) throw new Error("A Epic não devolveu o código de autorização.");
  return code;
}

function recordToDraft(record) {
  const meta = record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const catalogItemId = String(record.catalogItemId || meta.id || "").trim();
  if (!catalogItemId) return null;
  const namespace = String(record.namespace || record.sandboxId || meta.namespace || "");
  if (namespace.toLowerCase() === "ue") return null;
  const name = displayTitle(meta.title, record.title);
  const appName = String(record.appName || record.appId || meta.appName || "").trim();
  if (isEpicJunk(name, meta, {})) return null;
  if (meta.mainGameItem) return null;
  const cats = categoryPaths(meta);
  if (cats.some((cat) => cat.includes("engines") || cat.includes("software/editors"))) return null;
  return {
    catalogItemId,
    namespace,
    appName,
    name,
    cover: catalogCover(meta),
    storeUrl: storeUrlFor(meta, name),
  };
}

function assetToDraft(asset) {
  if (!asset || typeof asset !== "object") return null;
  return recordToDraft({
    catalogItemId: asset.catalogItemId,
    namespace: asset.namespace,
    appName: asset.appName,
    metadata: asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {},
    title: asset.metadata?.title,
  });
}

function catalogItemFromPayload(payload, catalogItemId) {
  if (!payload || typeof payload !== "object") return null;
  if (payload[catalogItemId]) return payload[catalogItemId];
  const lower = String(catalogItemId).toLowerCase();
  for (const [key, value] of Object.entries(payload)) {
    if (String(key).toLowerCase() === lower) return value;
  }
  return null;
}

function applyCatalogMeta(draft, meta) {
  if (!meta) {
    const name = displayTitle(draft.name);
    return name ? { ...draft, name, cover: String(draft.cover || "").trim() } : null;
  }
  if (isEpicJunk(meta.title, meta, {}) || meta.mainGameItem) return null;
  const cats = categoryPaths(meta);
  if (cats.some((cat) => cat.includes("engines") || cat.includes("software/editors"))) return null;
  if (cats.some((cat) => cat.includes("addons") || cat.includes("digitalextras")) && !cats.some((cat) => cat.includes("games"))) {
    return null;
  }
  const name = displayTitle(meta.title, draft.name);
  if (!name) return null;
  return {
    ...draft,
    name,
    cover: catalogCover(meta, draft),
    storeUrl: storeUrlFor(meta, name),
  };
}

async function fetchLauncherAssets(accessToken) {
  const url = new URL(`https://${LAUNCHER_HOST}/launcher/api/public/assets/Windows`);
  url.searchParams.set("label", "Live");
  const payload = await epicFetch(url, {
    headers: { Authorization: `bearer ${accessToken}` },
    timeoutMs: 30000,
  });
  return Array.isArray(payload) ? payload : [];
}

async function fetchCatalogItems(namespace, catalogItemIds, accessToken) {
  const ids = [...new Set((catalogItemIds || []).map(String).filter(Boolean))];
  if (!namespace || !ids.length) return {};
  const url = new URL(`https://${CATALOG_HOST}/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/bulk/items`);
  for (const id of ids) url.searchParams.append("id", id);
  url.searchParams.set("includeDLCDetails", "true");
  url.searchParams.set("includeMainGameDetails", "true");
  url.searchParams.set("country", "BR");
  url.searchParams.set("locale", "pt-BR");
  const headers = accessToken ? { Authorization: `bearer ${accessToken}` } : {};
  const payload = await epicFetch(url, { headers, timeoutMs: 25000 });
  return payload && typeof payload === "object" ? payload : {};
}

async function fetchCatalogItem(namespace, catalogItemId, accessToken) {
  const payload = await fetchCatalogItems(namespace, [catalogItemId], accessToken);
  return payload?.[catalogItemId] || null;
}

function needsCatalogMeta(draft) {
  return !isRealEpicTitle(draft?.name) || !String(draft?.cover || "").trim();
}

async function enrichDrafts(drafts, accessToken) {
  const ready = [];
  const pending = [];
  for (const draft of drafts) {
    if (needsCatalogMeta(draft)) pending.push(draft);
    else ready.push(draft);
  }
  const finishWithoutCatalog = (rows) => {
    for (const draft of rows) {
      const named = applyCatalogMeta(draft, null);
      if (named) ready.push(named);
    }
  };
  if (!accessToken) {
    finishWithoutCatalog(pending);
    return ready;
  }
  const byNs = new Map();
  for (const draft of pending) {
    if (!draft.namespace || !draft.catalogItemId) {
      finishWithoutCatalog([draft]);
      continue;
    }
    if (!byNs.has(draft.namespace)) byNs.set(draft.namespace, []);
    byNs.get(draft.namespace).push(draft);
  }
  const jobs = [];
  for (const [namespace, rows] of byNs) {
    for (let i = 0; i < rows.length; i += CATALOG_CHUNK) {
      jobs.push({ namespace, rows: rows.slice(i, i + CATALOG_CHUNK) });
    }
  }
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      try {
        const payload = await fetchCatalogItems(
          job.namespace,
          job.rows.map((row) => row.catalogItemId),
          accessToken
        );
        for (const draft of job.rows) {
          const named = applyCatalogMeta(draft, catalogItemFromPayload(payload, draft.catalogItemId));
          if (named) ready.push(named);
        }
      } catch {
        finishWithoutCatalog(job.rows);
      }
      if (next < jobs.length) await sleep(CATALOG_DELAY_MS);
    }
  }
  const workers = Math.max(1, Math.min(CATALOG_CONCURRENCY, jobs.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return ready;
}

async function loadIdMap(paths) {
  const stored = await readJson(paths.epicLibrary, { games: [] });
  const byCatalog = new Map();
  const used = new Set();
  for (const game of stored.games || []) {
    const catalogItemId = String(game.epicId || game.catalogItemId || "").trim();
    const appId = Number(game.appId);
    if (!catalogItemId || !isEpicAppId(appId)) continue;
    byCatalog.set(catalogItemId.toLowerCase(), appId);
    used.add(appId);
  }
  return { byCatalog, used };
}

function assignIds(drafts, idMap) {
  return drafts.map((draft) => {
    const key = draft.catalogItemId.toLowerCase();
    let appId = idMap.byCatalog.get(key);
    if (!appId) {
      appId = epicAppIdFor(draft.catalogItemId, idMap.used);
      idMap.byCatalog.set(key, appId);
    }
    return toOwnedRow({ ...draft, appId, name: displayTitle(draft.name) });
  });
}

async function fetchEpicOwned(config) {
  const paths = config?.paths || {};
  const idMap = paths.epicLibrary ? await loadIdMap(paths) : { byCatalog: new Map(), used: new Set() };
  const drafts = new Map();
  const add = (draft) => {
    if (!draft?.catalogItemId) return;
    const key = draft.catalogItemId.toLowerCase();
    const prev = drafts.get(key);
    if (!prev) {
      drafts.set(key, draft);
      return;
    }
    if (isRealEpicTitle(draft.name) && !isRealEpicTitle(prev.name)) prev.name = draft.name;
    if (!prev.appName && draft.appName) prev.appName = draft.appName;
    if (!prev.namespace && draft.namespace) prev.namespace = draft.namespace;
    if (!prev.cover && draft.cover) prev.cover = draft.cover;
    if (draft.storeUrl && !/browse\?q=/.test(draft.storeUrl)) prev.storeUrl = draft.storeUrl;
  };

  for (const row of await readInstalledEpicGames()) add(row);

  let session = null;
  let error = "";
  if (config?.epicRefreshToken) {
    try {
      session = await startEpicSession({ refreshToken: config.epicRefreshToken });
      const token = session.access_token;
      const records = await fetchLibraryRecords(token);
      for (const record of records) add(recordToDraft(record));
      try {
        const assets = await fetchLauncherAssets(token);
        for (const asset of assets) add(assetToDraft(asset));
      } catch {
        // library-service já cobre a conta; assets é reforço
      }
      const enriched = await enrichDrafts([...drafts.values()], token);
      drafts.clear();
      for (const row of enriched) add(row);
    } catch (err) {
      error = err.message || String(err);
    }
  }

  const games = assignIds(
    [...drafts.values()].filter((draft) => isRealEpicTitle(draft.name)),
    idMap
  );
  const payload = {
    updatedAt: nowIso(),
    source: session ? "epic-library" : games.length ? "epic-local" : "none",
    displayName: session?.displayName || session?.display_name || config?.epicDisplayName || "",
    accountId: session?.account_id || config?.epicAccountId || "",
    count: games.length,
    error,
    games,
  };
  if (paths.epicLibrary) await writeJson(paths.epicLibrary, payload);
  return {
    ...payload,
    refreshToken: session?.refresh_token || config?.epicRefreshToken || "",
  };
}

function parseEpicRedirectPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return { authorizationCode: "", sid: "" };
  try {
    const json = JSON.parse(raw);
    return {
      authorizationCode: String(json.authorizationCode || json.authorization_code || "").trim(),
      sid: String(json.sid || "").trim(),
    };
  } catch {
    const code = (raw.match(/"authorizationCode"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const sid = (raw.match(/"sid"\s*:\s*"([^"]+)"/) || [])[1] || "";
    return { authorizationCode: code, sid };
  }
}

function parseEpicRedirectBody(text) {
  return parseEpicRedirectPayload(text).authorizationCode;
}

module.exports = {
  EPIC_APP_BASE,
  isEpicAppId,
  isEpicGame,
  epicAuthUrl,
  startEpicSession,
  fetchEpicOwned,
  readInstalledEpicGames,
  parseEpicRedirectBody,
  parseEpicRedirectPayload,
  exchangeSidForCode,
  probeEglSession,
  importEglSession,
  CLIENT_ID,
  fetchCatalogItem,
  isEpicPlaceholderName,
  isRealEpicTitle,
  needsCatalogMeta,
  applyCatalogMeta,
  epicCoverFallbacks,
};
