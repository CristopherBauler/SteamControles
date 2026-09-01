/**
 * Shim de window.steamApp para o APK Capacitor.
 * No Electron o preload já define steamApp — este arquivo não faz nada.
 */
(function () {
  const cap = window.Capacitor;
  if (window.steamApp) return;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;

  document.documentElement.classList.add("capacitor");
  if (document.body) document.body.classList.add("capacitor");
  else document.addEventListener("DOMContentLoaded", () => document.body.classList.add("capacitor"));

  const SETTINGS_KEY = "mld.settings";
  const CACHE_KEY = "mld.cache";
  const LS_SETTINGS = "mld.settings";
  const LS_CACHE = "mld.cache";

  const DEFAULT_THEME = {
    general: "#12161d",
    button: "#2563eb",
    tabs: {
      novidades: "#2563eb",
      wishlist: "#2563eb",
      loja: "#2563eb",
      jogos: "#2563eb",
      backlog: "#2563eb",
    },
  };

  const DEFAULT_SETTINGS = {
    steamId: "",
    profileUrl: "",
    steamWebApiKey: "",
    currency: "BRL",
    country: "br",
    language: "portuguese",
    timezone: "America/Sao_Paulo",
    syncEveryHours: 12,
    startWithWindows: false,
    notifySales: true,
    notifyNews: true,
    theme: { ...DEFAULT_THEME, tabs: { ...DEFAULT_THEME.tabs } },
    layout: {},
    libraryLists: { lists: [], pins: {} },
    pendingSync: false,
    pcBaseUrl: "",
    pairCode: "",
  };

  const STEAM_HEADERS = {
    Accept: "application/json, text/xml;q=0.9, text/html;q=0.8, */*;q=0.7",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  };

  const EARLY_ACCESS_GENRE_ID = "70";
  const EARLY_ACCESS_TEXT = /early access|acesso antecipado/i;
  const APP_VERSION = "2.0.1";
  const APK_RELEASES_URL = "https://github.com/CristopherBauler/SteamControles/releases";
  const EA_SCHEMA = 2;
  const SKIP_APP_IDS = new Set([7, 228980, 250820]);
  const JUNK_NAME =
    /soundtrack|\bost\b|dedicated server|server dedicated|sound track|artwork book|^steamworks common|^steamvr\b|\bproton\b|^steam (game notes|input configs|screenshots|linux runtime)|eula$/i;

  const UPD_KIND_LABEL = {
    launch: "Lançamento",
    earlyAccess: "Saiu do acesso antecipado",
    dlc: "DLC",
    majorUpdate: "Grande atualização",
    update: "Atualização",
    smallUpdate: "Pequena atualização",
    content: "Conteúdo",
    news: "Notícias",
    sale: "Promoção",
    saleOff: "Saiu de promoção",
    price: "Preço",
  };
  const UPD_PATCH_KINDS = new Set(["launch", "earlyAccess", "dlc", "majorUpdate", "update", "smallUpdate", "content"]);
  const UPD_NEWS_KINDS = new Set(["news"]);
  const UPD_PROMO_KINDS = new Set(["sale", "saleOff", "price"]);

  const prefs = cap.Plugins && cap.Plugins.Preferences;
  const Browser = cap.Plugins && cap.Plugins.Browser;
  const StatusBar = cap.Plugins && cap.Plugins.StatusBar;
  const App = cap.Plugins && cap.Plugins.App;

  let settings = { ...DEFAULT_SETTINGS };
  let cache = emptyCache();
  let syncing = false;
  let syncProgress = null;
  const syncListeners = new Set();
  let bootPromise = null;

  function emptyCache() {
    return {
      games: [],
      events: [],
      mostWanted: [],
      ggPopular: [],
      storeHub: { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] },
      ggDeals: { newDeals: [], bestDeals: [] },
      libraryGames: [],
      skippedIds: [],
      skippedGames: [],
      libraryMeta: {},
      libraryReviews: {},
      lastSyncAt: null,
      fromPc: false,
      seededFromPc: false,
      novidadesHtml: "",
      lojaHtml: "",
      pendingSkips: [],
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function roundMoney(value) {
    if (value == null || Number.isNaN(Number(value))) return null;
    return Math.round(Number(value) * 100) / 100;
  }

  function centsToReais(cents) {
    if (cents == null || Number.isNaN(Number(cents))) return null;
    return roundMoney(Number(cents) / 100);
  }

  function formatBRL(value) {
    if (value == null) return "—";
    return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function normalizeTheme(theme) {
    const src = theme && typeof theme === "object" ? theme : {};
    const tabs = src.tabs && typeof src.tabs === "object" ? src.tabs : {};
    const clean = (value, fallback) => {
      const raw = String(value || "").replace("#", "").trim();
      const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
      return /^[0-9a-f]{6}$/i.test(full) ? `#${full.toLowerCase()}` : fallback;
    };
    return {
      general: clean(src.general, DEFAULT_THEME.general),
      button: clean(src.button, DEFAULT_THEME.button),
      tabs: Object.fromEntries(
        Object.keys(DEFAULT_THEME.tabs).map((id) => [id, clean(tabs[id], DEFAULT_THEME.tabs[id])])
      ),
    };
  }

  function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async function prefGet(key) {
    if (prefs && prefs.get) {
      try {
        const result = await prefs.get({ key });
        if (result && result.value != null) return result.value;
      } catch {
        // cai no localStorage
      }
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async function prefSet(key, value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (prefs && prefs.set) {
      try {
        await prefs.set({ key, value: text });
      } catch {
        // localStorage abaixo
      }
    }
    try {
      localStorage.setItem(key, text);
    } catch {
      // armazenamento cheio
    }
  }

  function mergeSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      ...DEFAULT_SETTINGS,
      ...src,
      theme: normalizeTheme(src.theme),
    };
  }

  async function loadAll() {
    const fromCallback = parseJson(localStorage.getItem("mld.openid"), null);
    const rawSettings = parseJson(await prefGet(SETTINGS_KEY), parseJson(localStorage.getItem(LS_SETTINGS), {}));
    settings = mergeSettings(rawSettings);
    if (fromCallback && fromCallback.steamId) {
      settings.steamId = String(fromCallback.steamId);
      settings.profileUrl = `https://steamcommunity.com/profiles/${settings.steamId}`;
      settings.pendingSync = true;
      try {
        localStorage.removeItem("mld.openid");
      } catch {
        // ignore
      }
      await prefSet(SETTINGS_KEY, settings);
    }
    cache = { ...emptyCache(), ...parseJson(await prefGet(CACHE_KEY), parseJson(localStorage.getItem(LS_CACHE), {})) };
    cache.skippedIds = Array.isArray(cache.skippedIds) ? cache.skippedIds.map(Number) : [];
    cache.pendingSkips = Array.isArray(cache.pendingSkips) ? cache.pendingSkips : [];
    if (
      cache.seededFromPc !== true &&
      cache.fromPc &&
      ((cache.games || []).length || (cache.libraryGames || []).length)
    ) {
      cache.seededFromPc = true;
    }
    const alreadyPaired =
      Boolean(settings.pcBaseUrl) && String(settings.pairCode || "").replace(/\D/g, "").length === 6;
    if (cache.eaSchema !== EA_SCHEMA) {
      cache.eaSchema = EA_SCHEMA;
      if (!alreadyPaired && (settings.steamId || settings.profileUrl)) {
        settings.pendingSync = true;
        await persistSettings();
      }
      await persistCache();
    }
  }

  async function persistSettings() {
    await prefSet(SETTINGS_KEY, settings);
  }

  async function persistCache() {
    await prefSet(CACHE_KEY, cache);
  }

  const PC_OFF_MSG = "PC não encontrado. Mesma Wi‑Fi e Conectar celular ligado.";
  const PC_CODE_MSG =
    "Código não bate. No PC: Ajustes → Conectar celular e cole o código novo. O anterior continua salvo até você conectar de novo.";

  function isPaired() {
    const pin = String(settings.pairCode || "").replace(/\D/g, "");
    return Boolean(settings.pcBaseUrl && pin.length === 6);
  }

  function normalizePcBase(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
    let url;
    try {
      url = new URL(text);
    } catch {
      return "";
    }
    if (!url.hostname) return "";
    const port = url.port || "17331";
    return `http://${url.hostname}:${port}`;
  }

  function pcRequestUrl(pathname) {
    const base = String(settings.pcBaseUrl || "").replace(/\/+$/, "");
    const url = new URL(pathname, `${base}/`);
    url.searchParams.set("code", String(settings.pairCode || "").replace(/\D/g, ""));
    return url.toString();
  }

  function queueSkip(appId, skipped) {
    const id = Number(appId);
    const next = (Array.isArray(cache.pendingSkips) ? cache.pendingSkips : []).filter(
      (item) => Number(item.appId) !== id
    );
    next.push({ appId: id, skipped: Boolean(skipped) });
    cache.pendingSkips = next;
  }

  function applyPcState(state) {
    if (!state || typeof state !== "object") return;
    cache.fromPc = true;
    cache.seededFromPc = true;
    cache.games = Array.isArray(state.games) ? state.games : [];
    cache.libraryGames = Array.isArray(state.libraryGames) ? state.libraryGames : [];
    cache.skippedGames = Array.isArray(state.skippedGames) ? state.skippedGames : [];
    cache.skippedIds = (Array.isArray(state.skippedAppIds) && state.skippedAppIds.length
      ? state.skippedAppIds
      : cache.skippedGames.map((game) => Number(game.appId))
    )
      .map(Number)
      .filter((id) => id > 0);
    cache.libraryMeta = state.libraryMeta && typeof state.libraryMeta === "object" ? state.libraryMeta : {};
    cache.novidadesHtml = state.novidadesHtml || "";
    cache.lojaHtml = state.lojaHtml || "";
    cache.lastSyncAt = state.lastSyncAt || nowIso();
    if (state.steamId) settings.steamId = String(state.steamId);
    if (state.profileUrl) settings.profileUrl = String(state.profileUrl);
    if (state.theme) settings.theme = normalizeTheme(state.theme);
  }

  function restackLibrary() {
    const skipped = new Set((cache.skippedIds || []).map(Number));
    const all = [...(cache.libraryGames || []), ...(cache.skippedGames || [])];
    const seen = new Map();
    for (const game of all) {
      const id = Number(game?.appId);
      if (id > 0 && !seen.has(id)) seen.set(id, game);
    }
    cache.libraryGames = [...seen.values()].filter((game) => !skipped.has(Number(game.appId)));
    cache.skippedGames = [...seen.values()].filter((game) => skipped.has(Number(game.appId)));
  }

  function applyRemoteMarks(ids) {
    const remote = new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => id > 0));
    for (const item of cache.pendingSkips || []) {
      const id = Number(item.appId);
      if (id <= 0) continue;
      if (item.skipped) remote.add(id);
      else remote.delete(id);
    }
    cache.skippedIds = [...remote];
    restackLibrary();
  }

  async function pcFetch(method, pathname, body) {
    if (!isPaired()) {
      const error = new Error(PC_OFF_MSG);
      error.status = 0;
      throw error;
    }
    const url = pcRequestUrl(pathname);
    const headers = {
      Accept: "application/json",
      "X-Pair-Code": String(settings.pairCode || "").replace(/\D/g, ""),
    };
    if (body != null) headers["Content-Type"] = "application/json";
    const Http = cap.Plugins && cap.Plugins.CapacitorHttp;
    try {
      if (Http && Http.request) {
        const res = await Http.request({
          url,
          method,
          headers,
          data: body != null ? body : undefined,
          connectTimeout: 8000,
          readTimeout: 60000,
        });
        const status = Number(res.status) || 0;
        let data = res.data;
        if (typeof data === "string") {
          try {
            data = JSON.parse(data);
          } catch {
            // texto
          }
        }
        if (status === 401) {
          const error = new Error(PC_CODE_MSG);
          error.status = 401;
          throw error;
        }
        if (status < 200 || status >= 400) {
          const error = new Error((data && data.error) || PC_OFF_MSG);
          error.status = status;
          throw error;
        }
        return data;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401) {
        const error = new Error(PC_CODE_MSG);
        error.status = 401;
        throw error;
      }
      if (!res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch {
          // ignore
        }
        const error = new Error((data && data.error) || PC_OFF_MSG);
        error.status = res.status;
        throw error;
      }
      return await res.json();
    } catch (error) {
      if (error && error.status === 401) throw error;
      const wrapped = new Error(PC_OFF_MSG);
      wrapped.status = 0;
      throw wrapped;
    }
  }

  async function pushPendingSkips() {
    const changes = (Array.isArray(cache.pendingSkips) ? cache.pendingSkips : []).filter(
      (item) => Number(item.appId) > 0
    );
    if (!changes.length) return null;
    const marks = await pcFetch("POST", "/skips", {
      changes: changes.map((item) => ({ appId: Number(item.appId), skipped: Boolean(item.skipped) })),
    });
    cache.pendingSkips = [];
    if (marks && Array.isArray(marks.skippedAppIds)) applyRemoteMarks(marks.skippedAppIds);
    return marks;
  }

  async function syncMarksWithPc() {
    if (!isPaired()) return false;
    await pushPendingSkips();
    const marks = await pcFetch("GET", "/marks");
    if (marks && Array.isArray(marks.skippedAppIds)) applyRemoteMarks(marks.skippedAppIds);
    if (marks?.steamId && !settings.steamId) settings.steamId = String(marks.steamId);
    if (marks?.profileUrl && !settings.profileUrl) settings.profileUrl = String(marks.profileUrl);
    await persistCache();
    await persistSettings();
    return true;
  }

  async function pullPcState() {
    await pushPendingSkips();
    const remote = await pcFetch("GET", "/state");
    applyPcState(remote);
    cache.pendingSkips = [];
    await persistCache();
    await persistSettings();
    return getStateSync();
  }

  function genreLooksEarlyAccess(item) {
    if (item == null || item === false) return false;
    if (typeof item === "string" || typeof item === "number") {
      const text = String(item).trim();
      return text === EARLY_ACCESS_GENRE_ID || EARLY_ACCESS_TEXT.test(text);
    }
    if (typeof item === "object") {
      const id = String(item.id ?? item.genreid ?? "");
      if (id === EARLY_ACCESS_GENRE_ID) return true;
      return EARLY_ACCESS_TEXT.test(String(item.description || "").trim());
    }
    return false;
  }

  function detectEarlyAccess(data) {
    if (!data || typeof data !== "object") return false;
    // Igual ao PC: só gênero 70 / texto de EA nas genres atuais. Tag leftover não conta.
    if (Array.isArray(data.genres)) {
      return data.genres.some(genreLooksEarlyAccess);
    }
    if (data.earlyAccess === true) return true;
    if (data.earlyAccess === false) return false;
    return false;
  }

  function isTbaReleaseDate(date) {
    const text = String(date || "").trim();
    if (!text) return false;
    return /to be announced|a ser anunciad|em breve|^tba$|coming soon|quando estiver/i.test(text);
  }

  function isUnreleased(game) {
    const amount = game?.currentPrice == null || game.currentPrice === "" ? null : Number(game.currentPrice);
    const price = Number.isFinite(amount) ? amount : null;
    if (price != null && price > 0) return false;
    if (game?.comingSoon === false) {
      if (price == null) return true;
      return false;
    }
    if (isTbaReleaseDate(game?.releaseDate)) return true;
    if (game?.comingSoon === true) return true;
    return price == null || price === 0;
  }

  function extractSteamId64(value) {
    const text = String(value || "").trim();
    const profile = text.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
    if (profile) return profile[1];
    const openid = text.match(/\/openid\/id\/(\d{17})/i);
    if (openid) return openid[1];
    if (/^7656119\d{10}$/.test(text)) return text;
    return null;
  }

  function extractVanity(value) {
    const text = String(value || "").trim();
    const vanity = text.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
    if (vanity) return decodeURIComponent(vanity[1]);
    if (text && !extractSteamId64(text) && !/^https?:/i.test(text) && !/^\d+$/.test(text)) return text;
    return null;
  }

  async function fetchRaw(url, { timeoutMs = 25000, method = "GET", body, headers } = {}) {
    const response = await fetch(url, {
      method,
      headers: { ...STEAM_HEADERS, ...(headers || {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { response, text };
  }

  async function fetchJson(url, options = {}) {
    const { text, response } = await fetchRaw(url, options);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("xml") || contentType.includes("html") || options.asText) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function mapPool(items, concurrency, worker, onItemDone) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function run() {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
        done += 1;
        if (typeof onItemDone === "function") {
          try {
            onItemDone(done, items.length, items[index], index);
          } catch {
            // progresso não pode quebrar o pool
          }
        }
      }
    }
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, run));
    return results;
  }

  async function resolveSteamId() {
    const direct = extractSteamId64(settings.steamId) || extractSteamId64(settings.profileUrl);
    if (direct) return direct;
    const vanity = extractVanity(settings.profileUrl) || extractVanity(settings.steamId);
    if (!vanity) throw new Error("Informe o SteamID64 ou entre com a Steam.");
    const xml = await fetchJson(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { asText: true });
    const match = String(xml).match(/<steamID64>(\d{17})<\/steamID64>/);
    if (!match) throw new Error(`Não foi possível resolver o perfil "${vanity}".`);
    return match[1];
  }

  async function fetchWishlist(steamId64) {
    const payload = await fetchJson(
      `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId64}`
    );
    const items = payload?.response?.items;
    if (!Array.isArray(items)) {
      throw new Error("Wishlist inacessível. Deixe a lista de desejos PÚBLICA em: Perfil Steam → Privacidade.");
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
      currentPrice: isFree ? 0 : centsToReais(overview?.final),
      initialPrice: isFree ? 0 : centsToReais(overview?.initial),
      discount: isFree ? 0 : Number(overview?.discount_percent || 0),
      headerImage: data?.header_image || capsuleUrl(appId),
      storeUrl: `https://store.steampowered.com/app/${appId}`,
      ggDealsUrl: `https://gg.deals/steam/app/${appId}/`,
      steamTags: tags,
      comingSoon: Boolean(data?.release_date?.coming_soon),
      releaseDate: String(data?.release_date?.date || "").trim(),
      genres: Array.isArray(data?.genres) ? data.genres : [],
      earlyAccess: detectEarlyAccess(data),
      onWishlist: true,
    };
  }

  function capsuleUrl(appId) {
    return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
  }

  function fallbackDetails(appId, prev) {
    return {
      appId,
      name: prev?.name || `App ${appId}`,
      isFree: Boolean(prev?.isFree),
      currentPrice: prev?.currentPrice ?? null,
      initialPrice: prev?.initialPrice ?? null,
      discount: Number(prev?.discount) || 0,
      headerImage: prev?.headerImage || capsuleUrl(appId),
      storeUrl: `https://store.steampowered.com/app/${appId}`,
      ggDealsUrl: `https://gg.deals/steam/app/${appId}/`,
      steamTags: prev?.steamTags || [],
      comingSoon: prev?.comingSoon,
      releaseDate: prev?.releaseDate || "",
      genres: Array.isArray(prev?.genres) ? prev.genres : undefined,
      earlyAccess: detectEarlyAccess(prev || {}),
      onWishlist: true,
      unavailable: true,
    };
  }

  async function fetchAppDetails(appId, prev) {
    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", String(appId));
    url.searchParams.set("cc", settings.country || "br");
    url.searchParams.set("l", settings.language || "portuguese");
    try {
      const payload = await fetchJson(url.toString(), { timeoutMs: 8000 });
      const entry = payload?.[String(appId)];
      if (!entry?.success || !entry.data) return fallbackDetails(appId, prev);
      return parseAppDetails(appId, entry.data);
    } catch {
      return fallbackDetails(appId, prev);
    }
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
        block.match(/class="title">([^<]+)/)?.[1] ||
        `App ${appId}`;
      const image =
        block.match(/search_capsule"><img src="([^"]+)"/)?.[1] ||
        block.match(/src="(https:\/\/[^"]+\/apps\/[^"]+)"/)?.[1] ||
        capsuleUrl(appId);
      const cents = Number(block.match(/data-price-final="(\d+)"/)?.[1] || 0);
      const discount = Number(
        block.match(/discount_pct[^>]*>\s*-?(\d+)\s*%/)?.[1] || block.match(/-(\d+)\s*%/)?.[1] || 0
      );
      games.push({
        rank: games.length + 1,
        appId,
        name: decodeHtml(name),
        image,
        headerImage: image,
        currentPrice: cents > 0 ? centsToReais(cents) : null,
        discount,
        storeUrl: `https://store.steampowered.com/app/${appId}`,
        ggDealsUrl: `https://gg.deals/steam/app/${appId}/`,
        source: "Steam",
      });
      if (games.length >= limit) break;
    }
    return games;
  }

  async function fetchSearchCatalog({ limit = 20, start = 0, params = {} } = {}) {
    const url = new URL("https://store.steampowered.com/search/results/");
    url.searchParams.set("start", String(start));
    url.searchParams.set("count", String(limit));
    url.searchParams.set("infinite", "1");
    url.searchParams.set("cc", settings.country || "br");
    url.searchParams.set("l", settings.language || "portuguese");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const payload = await fetchJson(url.toString());
    return parseSearchCatalog(payload?.results_html || "", limit);
  }

  function mapStoreItem(item, source = "Steam") {
    const appId = Number(item.id);
    const hasId = Number.isInteger(appId) && appId > 0;
    return {
      appId: hasId ? appId : null,
      name: decodeHtml(item.name),
      image: item.large_capsule_image || item.header_image || "",
      headerImage: item.header_image || item.large_capsule_image || "",
      currentPrice: item.final_price != null ? centsToReais(item.final_price) : null,
      discount: Number(item.discount_percent || 0),
      storeUrl: item.url || (hasId ? `https://store.steampowered.com/app/${appId}` : "https://store.steampowered.com/"),
      ggDealsUrl: hasId ? `https://gg.deals/steam/app/${appId}/` : "https://gg.deals/",
      source,
    };
  }

  async function fetchStoreHub() {
    const url = new URL("https://store.steampowered.com/api/featuredcategories");
    url.searchParams.set("cc", settings.country || "br");
    url.searchParams.set("l", settings.language || "portuguese");
    const data = await fetchJson(url.toString());
    const events = [];
    for (const key of Object.keys(data || {})) {
      if (!/^\d+$/.test(key)) continue;
      const cat = data[key] || {};
      for (const item of cat.items || []) {
        const mapped = mapStoreItem(item, cat.name || "Steam");
        let body = decodeHtml(String(item.body || "").replace(/%\d\$s/g, "").replace(/\s+/g, " "));
        if (!body || /termina em\s*\.?$/i.test(body)) body = cat.name || "";
        events.push({ name: mapped.name, image: item.header_image || mapped.image, url: mapped.storeUrl, body });
      }
    }
    const specials = (data.specials?.items || []).map((item) => mapStoreItem(item, "Steam"));
    let catalog = [];
    try {
      catalog = await fetchSearchCatalog({ limit: 40, params: { specials: "1" } });
    } catch {
      catalog = [];
    }
    const seen = new Set();
    const dealsStrip = [];
    for (const event of events.slice(0, 8)) dealsStrip.push({ kind: "event", ...event });
    for (const item of [...specials, ...catalog]) {
      if (item.appId && seen.has(item.appId)) continue;
      if (item.appId) seen.add(item.appId);
      dealsStrip.push({ kind: "game", ...item, headerImage: item.headerImage || item.image || "" });
    }
    return { events, specials: specials.slice(0, 12), newDeals: [], bestDeals: [], dealsStrip, catalog };
  }

  function toDealRow(game, store) {
    const appId = Number(game.appId);
    return {
      name: game.name,
      discount: Number(game.discount) || 0,
      currentPrice: game.currentPrice,
      priceLabel: game.currentPrice === 0 ? "Free" : null,
      store: store || game.source || "Steam",
      relativeTime: "",
      historicalLow: false,
      appId: Number.isInteger(appId) && appId > 0 ? appId : null,
      image: game.headerImage || game.image || "",
      headerImage: game.headerImage || game.image || "",
      storeUrl: game.storeUrl || (appId ? `https://store.steampowered.com/app/${appId}` : "https://store.steampowered.com/"),
      ggDealsUrl: game.ggDealsUrl || (appId ? `https://gg.deals/steam/app/${appId}/` : "https://gg.deals/"),
      source: store || game.source || "Steam",
    };
  }

  async function tryGgDeals() {
    try {
      const html = await fetchJson("https://gg.deals/", { timeoutMs: 4000, asText: true });
      if (/just a moment|cf-browser-verification|challenge-platform/i.test(String(html))) {
        throw new Error("Cloudflare");
      }
      return Boolean(html && String(html).length > 400);
    } catch {
      return false;
    }
  }

  function xmlTag(block, tag) {
    const cdata = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"));
    if (cdata) return decodeHtml(cdata[1]);
    const plain = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
    return decodeHtml(plain?.[1] || "");
  }

  function parseHoursValue(value) {
    const text = String(value || "").trim();
    if (!text) return 0;
    if (text.includes(",") && text.includes(".")) return Number(text.replace(/,/g, "")) || 0;
    if (text.includes(",") && !text.includes(".")) return Number(text.replace(",", ".")) || 0;
    return Number(text) || 0;
  }

  function parseOwnedGamesXml(xml) {
    const text = String(xml || "");
    if (!text.includes("<appID>")) return { games: [], privateProfile: true };
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
        hours,
        playtimeMinutes: Math.round(hours * 60),
      });
    }
    return { games, privateProfile: false };
  }

  async function fetchOwnedGamesFromXml(steamId64) {
    const xml = await fetchJson(`https://steamcommunity.com/profiles/${steamId64}/games?tab=all&xml=1`, {
      asText: true,
      timeoutMs: 20000,
    });
    return parseOwnedGamesXml(xml);
  }

  async function fetchOwnedGamesFromApi(steamId64, apiKey) {
    const url = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("steamid", String(steamId64));
    url.searchParams.set("include_appinfo", "1");
    url.searchParams.set("include_played_free_games", "1");
    url.searchParams.set("format", "json");
    const payload = await fetchJson(url.toString());
    const list = payload?.response?.games;
    if (!Array.isArray(list) || !list.length) return { games: [], privateProfile: true };
    const games = list
      .map((item) => {
        const appId = Number(item.appid);
        const minutes = Number(item.playtime_forever || 0);
        return {
          appId,
          name: item.name || `App ${appId}`,
          hours: minutes / 60,
          playtimeMinutes: minutes,
        };
      })
      .filter((game) => Number.isInteger(game.appId) && game.appId > 0);
    return { games, privateProfile: false };
  }

  function isJunkGame(game) {
    if (SKIP_APP_IDS.has(Number(game.appId))) return true;
    return JUNK_NAME.test(String(game.name || ""));
  }

  function publicGame(game) {
    const id = Number(game.appId);
    const cover = `https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_231x87.jpg`;
    return {
      appId: id,
      name: game.name || `App ${id}`,
      cover,
      covers: [
        cover,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`,
        capsuleUrl(id),
      ],
      hours: Number(game.hours) || 0,
      family: Boolean(game.family),
      storeUrl: `https://store.steampowered.com/app/${id}`,
      reviewPercent: game.reviewPercent != null && Number.isFinite(Number(game.reviewPercent)) ? Number(game.reviewPercent) : null,
      reviewTotal: Number(game.reviewTotal) || 0,
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
      const payload = await fetchJson(url.toString(), { timeoutMs: 8000 });
      const summary = payload?.query_summary || {};
      const total = Number(summary.total_reviews || 0);
      const percent = total > 0 ? Math.round((Number(summary.total_positive || 0) / total) * 100) : null;
      return { reviewPercent: percent, reviewTotal: total || 0 };
    } catch {
      return { reviewPercent: null, reviewTotal: null };
    }
  }

  function applyLibraryReviews(games) {
    const map = cache.libraryReviews && typeof cache.libraryReviews === "object" ? cache.libraryReviews : {};
    for (const game of games || []) {
      const hit = map[String(game.appId)];
      if (!hit) continue;
      if (hit.percent != null && Number.isFinite(Number(hit.percent))) game.reviewPercent = Number(hit.percent);
      game.reviewTotal = Number(hit.total) || 0;
    }
  }

  async function fillLibraryReviews(games) {
    if (!cache.libraryReviews || typeof cache.libraryReviews !== "object") cache.libraryReviews = {};
    const now = Date.now();
    const ttl = 14 * 24 * 60 * 60 * 1000;
    const stale = (games || [])
      .filter((game) => {
        const hit = cache.libraryReviews[String(game.appId)];
        if (!hit || !hit.fetchedAt) return true;
        const age = now - Date.parse(hit.fetchedAt);
        return !Number.isFinite(age) || age > ttl;
      })
      .slice(0, 80);
    if (!stale.length) return;
    await mapPool(stale, 3, async (game) => {
      const reviews = await fetchReviews(game.appId);
      if (reviews.reviewPercent == null && reviews.reviewTotal == null) return;
      cache.libraryReviews[String(game.appId)] = {
        percent: reviews.reviewPercent,
        total: reviews.reviewTotal || 0,
        fetchedAt: nowIso(),
      };
    });
    await persistCache();
  }

  async function fetchLibrary(steamId64, onTick) {
    const owned = new Map();
    let source = "none";
    let xmlOk = false;
    let apiOk = false;
    if (onTick) onTick(1, 3, "biblioteca");
    if (settings.steamWebApiKey) {
      try {
        const api = await fetchOwnedGamesFromApi(steamId64, settings.steamWebApiKey);
        if (api.games.length) {
          apiOk = true;
          source = "api";
          for (const game of api.games) owned.set(game.appId, game);
        }
      } catch {
        apiOk = false;
      }
    }
    if (onTick) onTick(2, 3, "biblioteca");
    try {
      const xml = await fetchOwnedGamesFromXml(steamId64);
      if (xml.games.length) {
        xmlOk = true;
        if (!apiOk) source = "xml";
        for (const game of xml.games) {
          const prev = owned.get(game.appId);
          if (!prev) owned.set(game.appId, game);
          else if ((game.hours || 0) > (prev.hours || 0)) owned.set(game.appId, { ...prev, ...game });
        }
      }
    } catch {
      xmlOk = false;
    }
    if (onTick) onTick(3, 3, "biblioteca");
    const games = [...owned.values()].filter((game) => !isJunkGame(game)).map(publicGame);
    const skipped = new Set(cache.skippedIds.map(Number));
    const previous = [...(cache.libraryGames || []), ...(cache.skippedGames || [])];
    const catalog = games.length ? [...games] : previous;
    if (games.length) {
      const have = new Set(games.map((game) => Number(game.appId)));
      for (const game of previous) {
        const id = Number(game.appId);
        if (id && !have.has(id) && skipped.has(id)) catalog.push(game);
      }
    }
    const open = catalog.filter((game) => !skipped.has(Number(game.appId)));
    const done = catalog.filter((game) => skipped.has(Number(game.appId)));
    await fillLibraryReviews([...open, ...done]);
    applyLibraryReviews(open);
    applyLibraryReviews(done);
    const payload = { source, games, communityPrivate: !xmlOk && !apiOk };
    let hint = "";
    let sourceHint = "sem horas da Steam";
    if (!games.length && previous.length) {
      source = cache.libraryMeta?.source || "cache";
      sourceHint = "cópia local (PC ou sync anterior)";
      hint = "A Steam não atualizou a biblioteca agora. Mantive a lista que já estava neste celular.";
    } else if (source === "api") sourceHint = "fonte: API da Steam";
    else if (source === "xml") sourceHint = "fonte: perfil público";
    if (!catalog.length) {
      hint =
        "Biblioteca não veio. Pareie com o PC na primeira vez, ou deixe Detalhes dos jogos = Público / chave Web API.";
    }
    return {
      libraryGames: open,
      skippedGames: done,
      libraryMeta: { source, hint, sourceHint, familyComplete: false, familyCount: 0 },
    };
  }

  function stripBb(text) {
    return String(text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/https?:\/\/\s+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchAppNews(appId) {
    const url = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
    url.searchParams.set("appid", String(appId));
    url.searchParams.set("count", "2");
    url.searchParams.set("maxlength", "180");
    url.searchParams.set("format", "json");
    url.searchParams.set("feeds", "steam_community_announcements");
    const payload = await fetchJson(url.toString(), { timeoutMs: 8000 });
    return Array.isArray(payload?.appnews?.newsitems) ? payload.appnews.newsitems : [];
  }

  function keepRecent(events) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return (events || []).filter((event) => {
      const at = Date.parse(event.at || "") || 0;
      return at >= cutoff;
    });
  }

  function priceEvents(prevGames, nextGames) {
    const prevMap = new Map((prevGames || []).map((game) => [Number(game.appId), game]));
    const events = [];
    for (const game of nextGames || []) {
      const prev = prevMap.get(Number(game.appId));
      const unreleased = isUnreleased(game);
      if (prev && Number(game.discount) > 0 && !(Number(prev.discount) > 0) && !unreleased) {
        events.push({
          kind: "sale",
          name: game.name,
          title: `${game.name} em promoção`,
          text: formatBRL(game.currentPrice),
          at: nowIso(),
          headerImage: game.headerImage,
          storeUrl: game.storeUrl,
        });
      } else if (prev && Number(prev.discount) > 0 && !(Number(game.discount) > 0) && !unreleased) {
        events.push({
          kind: "saleOff",
          name: game.name,
          title: `${game.name} saiu de promoção`,
          text: formatBRL(game.currentPrice),
          at: nowIso(),
          headerImage: game.headerImage,
          storeUrl: game.storeUrl,
        });
      }
      if (prev?.comingSoon === true && game.comingSoon === false && !unreleased) {
        events.push({
          kind: "launch",
          name: game.name,
          title: `${game.name} lançou`,
          text: "",
          at: nowIso(),
          headerImage: game.headerImage,
          storeUrl: game.storeUrl,
        });
      }
    }
    return events;
  }

  function formatUpdWhen(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(+date)) return "";
    const day = new Intl.DateTimeFormat("pt-BR", { timeZone: settings.timezone, day: "numeric" }).format(date);
    const month = new Intl.DateTimeFormat("pt-BR", { timeZone: settings.timezone, month: "long" }).format(date);
    return `${day} DE ${month}`.toUpperCase();
  }

  function updateCard(event) {
    const img = event.headerImage
      ? `<img src="${esc(event.headerImage)}" alt="">`
      : `<div class="gwd-upd-ph"></div>`;
    const kind = UPD_KIND_LABEL[event.kind] || "Atualização";
    const when = formatUpdWhen(event.at);
    const gameName = event.name || "";
    return `<a class="gwd-upd gwd-upd-${esc(event.kind || "news")}" href="${esc(event.storeUrl || "#")}">
      <div class="gwd-upd-inner">
        <div class="gwd-upd-art">${img}${gameName ? `<div class="gwd-upd-gametag">${esc(gameName)}</div>` : ""}</div>
        <div class="gwd-upd-body">
          ${gameName ? `<div class="gwd-upd-gamepill">${esc(gameName)}</div>` : ""}
          <div class="gwd-upd-kicker">${esc(kind.toUpperCase())}${when ? ` · ${esc(when)}` : ""}</div>
          <div class="gwd-upd-name">${esc(event.title || event.name)}</div>
          ${event.text ? `<div class="gwd-upd-text">${esc(event.text)}</div>` : ""}
        </div>
      </div>
    </a>`;
  }

  function updatesColumn(title, events, empty, tileId) {
    const id = tileId ? ` data-board-tile="${esc(tileId)}"` : "";
    if (!events.length) {
      return `<div class="gwd-updates-col board-tile"${id}>
        <div class="gwd-updates-col-head">${esc(title)}</div>
        <div class="gwd-updates-quiet">${esc(empty)}</div>
      </div>`;
    }
    return `<div class="gwd-updates-col board-tile"${id}>
      <div class="gwd-updates-col-head">${esc(title)} <span>${events.length}</span></div>
      <div class="gwd-upd-day-list">${events.map(updateCard).join("")}</div>
    </div>`;
  }

  function updatesBanner(events) {
    const list = events || [];
    const patches = list.filter((event) => UPD_PATCH_KINDS.has(event.kind)).slice(0, 8);
    const news = list.filter((event) => UPD_NEWS_KINDS.has(event.kind)).slice(0, 8);
    const promos = list.filter((event) => UPD_PROMO_KINDS.has(event.kind)).slice(0, 6);
    if (!patches.length && !news.length && !promos.length) {
      return `<div class="gwd-updates gwd-updates-quiet">Nenhuma atualização na wishlist nos últimos 7 dias.</div>`;
    }
    return `<div class="gwd-updates" data-board="novidades">
      <div class="gwd-updates-head">Novidades da wishlist</div>
      <div class="gwd-updates-hint">últimos 7 dias · arraste as seções e mude o tamanho</div>
      ${updatesColumn("Atualizações", patches, "Nenhum patch ou lançamento nesta semana.", "patches")}
      ${updatesColumn("Notícias", news, "Nenhuma notícia nesta semana.", "news")}
      ${
        promos.length
          ? `<div class="gwd-updates-promo board-tile" data-board-tile="promos">
        <div class="gwd-updates-col-head">Promoções <span>${promos.length}</span></div>
        <div class="gwd-upd-day-list">${promos.map(updateCard).join("")}</div>
      </div>`
          : `<div class="gwd-updates-promo board-tile" data-board-tile="promos">
        <div class="gwd-updates-col-head">Promoções</div>
        <div class="gwd-updates-quiet">Nenhuma promoção nesta semana.</div>
      </div>`
      }
    </div>`;
  }

  function cover(game) {
    const raw = String(game?.headerImage || game?.image || "");
    if (raw && !/img\.gg\.deals/i.test(raw)) return raw;
    const id = Number(game?.appId);
    if (Number.isInteger(id) && id > 0) return capsuleUrl(id);
    return "";
  }

  function dealCoverError(img) {
    const next = String(img.getAttribute("data-fallback") || "").trim();
    if (next && img.getAttribute("src") !== next) {
      img.removeAttribute("data-fallback");
      img.src = next;
      return;
    }
    const ph = document.createElement("div");
    ph.className = "gwd-deal-ph";
    img.replaceWith(ph);
  }
  window.dealCoverError = dealCoverError;

  function dealThumb(game) {
    const img = cover(game);
    const id = Number(game?.appId);
    const fallback =
      Number.isInteger(id) && id > 0
        ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`
        : "";
    if (!img && !fallback) return `<div class="gwd-deal-ph"></div>`;
    const src = img || fallback;
    const next = src === fallback ? "" : fallback;
    const err = next
      ? ` data-fallback="${esc(next)}" onerror="dealCoverError(this)"`
      : ` onerror="dealCoverError(this)"`;
    return `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer"${err}>`;
  }

  function discTag(discount) {
    if (!Number(discount)) return "";
    return `<span class="gwd-disc">-${esc(discount)}%</span>`;
  }

  function priceLine(game) {
    if (isUnreleased(game)) return `<span class="gwd-soon">Em breve</span>`;
    const price =
      game.currentPrice === 0
        ? `<span style="color:#3dd68c;font-weight:700">Free</span>`
        : `<span style="color:#4da3ff;font-weight:700">${esc(formatBRL(game.currentPrice))}</span>`;
    return `${price} ${discTag(game.discount)}`;
  }

  function sectionHead(title, extra, link) {
    const bits = [];
    if (extra) bits.push(esc(extra));
    if (link?.href) bits.push(`<a class="gwd-seclink" href="${esc(link.href)}">${esc(link.label || "Abrir")}</a>`);
    return `<div class="gwd-sechead">
      <div class="gwd-sectitle">${esc(title)}</div>
      <div class="gwd-secextra">${bits.join(" · ")}</div>
    </div>`;
  }

  function scrollRow(cardsHtml) {
    if (!cardsHtml) return `<div class="gwd-empty">Nada para mostrar agora.</div>`;
    return `<div class="gwd-scroller"><div class="gwd-track">${cardsHtml}</div></div>`;
  }

  function gameCard(game, { rank, href } = {}) {
    const img = cover(game);
    const art = img ? `<img src="${esc(img)}" alt="">` : `<div class="gwd-card-ph"></div>`;
    const link = href || game.storeUrl || "#";
    return `<a class="gwd-card" href="${esc(link)}">
      <div class="gwd-card-art">
        ${art}
        ${rank != null ? `<span class="gwd-rank">#${rank}</span>` : ""}
      </div>
      <div class="gwd-card-name">${esc(game.name)}</div>
      <div class="gwd-card-price">${priceLine(game)}</div>
    </a>`;
  }

  function eventBanner(event) {
    if (!event?.image) return "";
    return `<a class="gwd-ev" href="${esc(event.url || event.storeUrl || "#")}">
      <img src="${esc(event.image)}" alt="">
      <div class="gwd-ev-cap">
        <div class="gwd-ev-name">${esc(event.name)}</div>
        ${event.body ? `<div class="gwd-ev-body">${esc(event.body)}</div>` : ""}
      </div>
    </a>`;
  }

  function dealRow(game) {
    const thumb = dealThumb(game);
    const href = game.storeUrl || game.ggDealsUrl || "#";
    const meta = [game.store || game.source || "Steam", game.relativeTime].filter(Boolean).join(" · ");
    const price =
      game.currentPrice === 0
        ? `<span style="color:#3dd68c;font-weight:700">Free</span>`
        : game.currentPrice != null
          ? esc(formatBRL(game.currentPrice))
          : "—";
    return `<a class="gwd-deal" href="${esc(href)}">
      ${thumb}
      <div class="gwd-deal-main">
        <div class="gwd-deal-name">${esc(game.name)}</div>
        <div class="gwd-deal-src">${esc(meta)}</div>
      </div>
      <div class="gwd-deal-right">${discTag(game.discount)}<div class="gwd-deal-price">${price}</div></div>
    </a>`;
  }

  function storePageHtml({ mostWanted, ggPopular, storeHub, ggDeals, ggBlocked }) {
    const popularCards = (mostWanted || [])
      .map((game) => gameCard(game, { rank: game.rank, href: game.storeUrl }))
      .join("");
    const ggCards = (ggPopular || []).map((game) => gameCard(game, { rank: game.rank, href: game.storeUrl })).join("");
    const dealCards = (storeHub.dealsStrip || []).length
      ? storeHub.dealsStrip
          .map((item) => (item.kind === "event" ? eventBanner(item) : gameCard(item, { href: item.storeUrl })))
          .join("")
      : (storeHub.specials || []).map((item) => gameCard(item, { href: item.storeUrl })).join("");
    const newDeals =
      (ggDeals.newDeals || []).map(dealRow).join("") ||
      `<div class="gwd-empty">${ggBlocked ? "gg.deals bloqueado (Cloudflare). Mostrando ofertas da Steam." : "Sem ofertas novas agora."}</div>`;
    const bestDeals =
      (ggDeals.bestDeals || []).map(dealRow).join("") || `<div class="gwd-empty">Sem best deals agora.</div>`;
    return `<div class="gwd-store" data-board="loja">
      <div class="board-tile" data-board-tile="wanted">
        ${sectionHead("Mais desejados na Steam", "ranking público da loja")}
        ${scrollRow(popularCards)}
      </div>
      <div class="board-tile" data-board-tile="popular">
        ${sectionHead("Em evidência", ggBlocked ? "Steam · gg.deals indisponível neste celular" : "loja · capas da Steam", { href: "https://gg.deals/", label: "Abrir gg.deals" })}
        ${scrollRow(ggCards || popularCards)}
      </div>
      <div class="board-tile" data-board-tile="steam">
        ${sectionHead("Descontos e eventos da Steam", "promoções do dia · toque abre a Steam")}
        ${scrollRow(dealCards)}
      </div>
      <div class="board-tile" data-board-tile="newdeals">
        ${sectionHead("Ofertas", "Steam store · toque abre o app da Steam", { href: "https://store.steampowered.com/specials/", label: "Especiais Steam" })}
        ${newDeals}
      </div>
      <div class="board-tile" data-board-tile="bestdeals">
        ${sectionHead("Melhores descontos", "Steam · ou gg.deals no navegador", { href: "https://gg.deals/", label: "Ver no gg.deals" })}
        ${bestDeals}
      </div>
    </div>`;
  }

  function wishView(game) {
    const unreleased = isUnreleased(game);
    return {
      appId: game.appId,
      name: game.name,
      headerImage: game.headerImage,
      currentPrice: game.currentPrice,
      discount: Number(game.discount) || 0,
      storeUrl: game.storeUrl || `https://store.steampowered.com/app/${game.appId}`,
      comingSoon: game.comingSoon,
      releaseDate: game.releaseDate || "",
      isFree: Boolean(game.isFree),
      unreleased,
      genres: Array.isArray(game.genres) ? game.genres : undefined,
      earlyAccess: detectEarlyAccess(game),
      priceLabel: formatBRL(game.currentPrice),
    };
  }

  function getStateSync() {
    const games = (cache.games || []).map(wishView);
    const comingCount = games.filter((game) => game.unreleased).length;
    const saleCount = games.filter((game) => !game.unreleased && Number(game.discount) > 0).length;
    const fullCount = games.filter((game) => !game.unreleased && !Number(game.discount)).length;
    const eaCount = games.filter((game) => game.earlyAccess).length;
    const skipped = new Set((cache.skippedIds || []).map(Number));
    const libraryGames = (cache.libraryGames || []).filter((game) => !skipped.has(Number(game.appId)));
    const skippedGames = (cache.skippedGames || []).length
      ? cache.skippedGames
      : (cache.libraryGames || []).filter((game) => skipped.has(Number(game.appId)));
    applyLibraryReviews(libraryGames);
    applyLibraryReviews(skippedGames);
    return {
      steamId: settings.steamId,
      profileUrl: settings.profileUrl,
      steamWebApiKey: settings.steamWebApiKey ? "••••" : "",
      hasApiKey: Boolean(settings.steamWebApiKey),
      syncEveryHours: settings.syncEveryHours,
      startWithWindows: false,
      notifySales: settings.notifySales,
      notifyNews: settings.notifyNews,
      theme: normalizeTheme(settings.theme),
      layout: settings.layout && typeof settings.layout === "object" ? settings.layout : {},
      libraryLists:
        settings.libraryLists && typeof settings.libraryLists === "object"
          ? settings.libraryLists
          : { lists: [], pins: {} },
      timezone: settings.timezone || "America/Sao_Paulo",
      appVersion: APP_VERSION,
      apkUrl: APK_RELEASES_URL,
      syncing,
      syncPercent: syncing ? syncProgress?.percent ?? 0 : null,
      syncLabel: syncing ? syncProgress?.label || "" : "",
      lastSyncAt: cache.lastSyncAt,
      nextSyncAt: null,
      packaged: true,
      dataPath: "neste celular (Preferências do app — não vai para o git)",
      wishCount: games.length,
      onSale: saleCount,
      comingCount,
      fullCount,
      eaCount,
      backlogOpen: libraryGames.length,
      backlogDone: skippedGames.length,
      libraryGames,
      skippedGames,
      libraryMeta: cache.libraryMeta || {},
      novidadesHtml:
        cache.fromPc && cache.novidadesHtml
          ? cache.novidadesHtml
          : updatesBanner(cache.events || []),
      lojaHtml:
        cache.fromPc && cache.lojaHtml
          ? cache.lojaHtml
          : storePageHtml({
              mostWanted: cache.mostWanted || [],
              ggPopular: cache.ggPopular || [],
              storeHub: cache.storeHub || { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] },
              ggDeals: cache.ggDeals || { newDeals: [], bestDeals: [] },
              ggBlocked: Boolean(cache.ggBlocked),
            }),
      games,
      mobile: true,
      paired: isPaired(),
      seededFromPc: Boolean(cache.seededFromPc),
      pcHost: settings.pcBaseUrl || "",
    };
  }

  function emitSync(payload) {
    for (const handler of syncListeners) {
      try {
        handler(payload);
      } catch {
        // UI
      }
    }
  }

  function createSyncProgress(onProgress) {
    const stages = [
      { id: "wishlist", label: "wishlist", weight: 12 },
      { id: "loja", label: "loja", weight: 18 },
      { id: "precos", label: "preços", weight: 35 },
      { id: "noticias", label: "notícias", weight: 15 },
      { id: "backlog", label: "backlog", weight: 20 },
    ];
    const before = {};
    let acc = 0;
    for (const stage of stages) {
      before[stage.id] = acc;
      acc += stage.weight;
    }
    const byId = Object.fromEntries(stages.map((stage) => [stage.id, stage]));
    function report(phase, current, total, label) {
      const stage = byId[phase] || byId.wishlist;
      const frac = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
      const raw = before[stage.id] + stage.weight * frac;
      const payload = {
        phase: stage.id,
        label: label || stage.label,
        current: Number(current) || 0,
        total: Number(total) || 0,
        percent: Math.max(0, Math.min(99, Math.round(raw))),
      };
      syncProgress = payload;
      onProgress(payload);
    }
    return {
      start(phase, total = 0, label) {
        report(phase, 0, total, label);
      },
      tick(phase, current, total, label) {
        report(phase, current, total, label);
      },
      done(phase, label) {
        report(phase, 1, 1, label);
      },
    };
  }

  async function syncNow(options = {}) {
    await bootPromise;
    if (syncing) return { ok: false, message: "Já está sincronizando." };
    const reseed = Boolean(options.reseed);

    if (isPaired() && (reseed || !cache.seededFromPc)) {
      syncing = true;
      syncProgress = { percent: 20, label: "PC" };
      emitSync({ syncing: true, percent: 20, label: "espelho do PC" });
      try {
        const state = await pullPcState();
        cache.seededFromPc = true;
        cache.fromPc = true;
        await persistCache();
        syncing = false;
        syncProgress = null;
        emitSync({ syncing: false, state });
        return { ok: true, state };
      } catch (error) {
        const message = error.message || PC_OFF_MSG;
        syncing = false;
        syncProgress = null;
        emitSync({ syncing: false, error: message, state: getStateSync() });
        return { ok: false, message, state: getStateSync() };
      }
    }

    if (isPaired()) {
      emitSync({ syncing: true, percent: 8, label: "marcas" });
      try {
        await syncMarksWithPc();
      } catch {
        // PC off: segue com o que está neste celular
      }
    }

    if (!settings.steamId && !settings.profileUrl) {
      if (cache.seededFromPc) {
        const state = getStateSync();
        emitSync({ syncing: false, state });
        return { ok: true, state };
      }
      return { ok: false, message: "Conecte a Steam antes de sincronizar." };
    }
    syncing = true;
    syncProgress = { percent: 0, label: "wishlist" };
    const progress = createSyncProgress((payload) => {
      emitSync({ syncing: true, ...payload });
    });
    progress.start("wishlist");
    try {
      const steamId64 = await resolveSteamId();
      settings.steamId = steamId64;
      settings.profileUrl = settings.profileUrl || `https://steamcommunity.com/profiles/${steamId64}`;
      await persistSettings();

      progress.tick("wishlist", 1, 2);
      const items = await fetchWishlist(steamId64);
      progress.done("wishlist");

      progress.start("loja");
      let mostWanted = [];
      let storeHub = { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [], catalog: [] };
      let ggBlocked = true;
      try {
        mostWanted = await fetchSearchCatalog({ limit: 20, params: { filter: "popularwishlist" } });
      } catch {
        mostWanted = cache.mostWanted || [];
      }
      progress.tick("loja", 1, 3);
      try {
        storeHub = await fetchStoreHub();
      } catch {
        storeHub = cache.storeHub || storeHub;
      }
      progress.tick("loja", 2, 3, "gg.deals");
      ggBlocked = !(await tryGgDeals());
      const steamDeals = (storeHub.catalog || storeHub.specials || []).map((game) => toDealRow(game, "Steam"));
      const ggDeals = {
        newDeals: steamDeals.slice(0, 12),
        bestDeals: [...steamDeals].sort((a, b) => Number(b.discount || 0) - Number(a.discount || 0)).slice(0, 12),
      };
      const ggPopular = mostWanted.slice(0, 20);
      progress.done("loja");

      const prevById = new Map((cache.games || []).map((game) => [Number(game.appId), game]));
      progress.start("precos", items.length);
      const details = await mapPool(
        items,
        3,
        (item) => fetchAppDetails(item.appId, prevById.get(item.appId)),
        (done, total) => progress.tick("precos", done, total, "preços")
      );
      progress.done("precos");

      const games = details.filter(Boolean);
      progress.start("noticias");
      let events = keepRecent([...(cache.events || []), ...priceEvents(cache.games, games)]);
      const newsTargets = games.filter((game) => Number(game.discount) > 0).slice(0, 8);
      const newsPool = newsTargets.length ? newsTargets : games.slice(0, 6);
      await mapPool(
        newsPool,
        3,
        async (game) => {
          try {
            const news = await fetchAppNews(game.appId);
            const item = news[0];
            if (!item) return;
            const at = item.date ? new Date(Number(item.date) * 1000).toISOString() : nowIso();
            if (Date.parse(at) < Date.now() - 7 * 24 * 60 * 60 * 1000) return;
            events.push({
              kind: "news",
              name: game.name,
              title: stripBb(item.title) || game.name,
              text: stripBb(item.contents).slice(0, 180),
              at,
              headerImage: game.headerImage,
              storeUrl: game.storeUrl,
            });
          } catch {
            // notícia individual não derruba o sync
          }
        },
        (done, total) => progress.tick("noticias", done, total)
      );
      events = keepRecent(events).slice(0, 40);
      progress.done("noticias");

      progress.start("backlog");
      const library = await fetchLibrary(steamId64, (current, total, label) =>
        progress.tick("backlog", current, total, label)
      );
      progress.done("backlog");

      cache = {
        ...cache,
        games,
        events,
        mostWanted,
        ggPopular,
        storeHub,
        ggDeals,
        ggBlocked,
        libraryGames: library.libraryGames,
        skippedGames: library.skippedGames,
        libraryMeta: library.libraryMeta,
        lastSyncAt: nowIso(),
        fromPc: false,
        seededFromPc: cache.seededFromPc || isPaired(),
      };
      await persistCache();
      syncing = false;
      syncProgress = null;
      const state = getStateSync();
      emitSync({ syncing: false, state });
      return { ok: true, state };
    } catch (error) {
      const message = error.message || String(error);
      syncing = false;
      syncProgress = null;
      emitSync({ syncing: false, error: message });
      return { ok: false, message, state: getStateSync() };
    }
  }

  async function saveSettings(partial) {
    await bootPromise;
    const next = { ...settings };
    if (partial.steamId != null) {
      const raw = String(partial.steamId).trim();
      next.steamId = extractSteamId64(raw) || raw;
      if (partial.profileUrl == null) {
        const id = extractSteamId64(next.steamId);
        next.profileUrl = id ? `https://steamcommunity.com/profiles/${id}` : next.steamId ? raw : "";
      }
    }
    if (partial.profileUrl != null) next.profileUrl = String(partial.profileUrl).trim();
    if (partial.steamWebApiKey != null && partial.steamWebApiKey !== "••••") {
      next.steamWebApiKey = String(partial.steamWebApiKey).trim();
    }
    if (partial.syncEveryHours != null) next.syncEveryHours = Number(partial.syncEveryHours) || 12;
    if (partial.notifySales != null) next.notifySales = Boolean(partial.notifySales);
    if (partial.notifyNews != null) next.notifyNews = Boolean(partial.notifyNews);
    if (partial.theme != null) next.theme = normalizeTheme({ ...next.theme, ...partial.theme, tabs: { ...next.theme.tabs, ...(partial.theme.tabs || {}) } });
    if (partial.layout != null && typeof partial.layout === "object" && !Array.isArray(partial.layout)) {
      next.layout = partial.layout;
    }
    if (partial.libraryLists != null && typeof partial.libraryLists === "object" && !Array.isArray(partial.libraryLists)) {
      next.libraryLists = partial.libraryLists;
    }
    if (partial.pcBaseUrl != null) next.pcBaseUrl = normalizePcBase(partial.pcBaseUrl);
    if (partial.pairCode != null) next.pairCode = String(partial.pairCode).replace(/\D/g, "").slice(0, 6);
    settings = mergeSettings(next);
    await persistSettings();
    return getStateSync();
  }

  function steamAuthOrigin() {
    const origin = String(window.location.origin || "").replace(/\/$/, "");
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
    if (/^https?:\/\//i.test(origin) && !/^file:/i.test(origin) && !/^capacitor:/i.test(origin)) {
      return origin;
    }
    return "http://localhost";
  }

  function steamAuthUrl() {
    const realm = steamAuthOrigin();
    const returnTo = `${realm}/steam-callback.html`;
    const params = new URLSearchParams({
      "openid.ns": "http://specs.openid.net/auth/2.0",
      "openid.mode": "checkid_setup",
      "openid.return_to": returnTo,
      "openid.realm": realm,
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    });
    return `https://steamcommunity.com/openid/login?${params}`;
  }

  async function login() {
    await bootPromise;
    const url = steamAuthUrl();
    // OpenID no mesmo WebView: return_to tem que ser http(s) deste origin (não file://, não Custom Tabs).
    window.location.href = url;
    return new Promise(() => {});
  }

  async function logout() {
    await bootPromise;
    settings.steamId = "";
    settings.profileUrl = "";
    settings.pendingSync = false;
    try {
      localStorage.removeItem("mld.openid");
    } catch {
      // ignore
    }
    await persistSettings();
    return getStateSync();
  }

  async function toggleSkipped(payload) {
    await bootPromise;
    const appId = Number(payload?.appId);
    if (!Number.isInteger(appId) || appId <= 0) return getStateSync();
    const skipped = new Set((cache.skippedIds || []).map(Number));
    if (payload.skipped) skipped.add(appId);
    else skipped.delete(appId);
    cache.skippedIds = [...skipped];
    const all = [...(cache.libraryGames || []), ...(cache.skippedGames || [])];
    const seen = new Map();
    for (const game of all) seen.set(Number(game.appId), game);
    cache.libraryGames = [...seen.values()].filter((game) => !skipped.has(Number(game.appId)));
    cache.skippedGames = [...seen.values()].filter((game) => skipped.has(Number(game.appId)));
    queueSkip(appId, payload.skipped);
    await persistCache();
    if (!isPaired()) return getStateSync();
    try {
      const marks = await pcFetch("POST", "/skip", { appId, skipped: Boolean(payload.skipped) });
      cache.pendingSkips = (cache.pendingSkips || []).filter((item) => Number(item.appId) !== appId);
      if (marks && Array.isArray(marks.skippedAppIds)) applyRemoteMarks(marks.skippedAppIds);
      await persistCache();
      return getStateSync();
    } catch {
      return getStateSync();
    }
  }

  async function connectPc(payload = {}) {
    await bootPromise;
    const base = normalizePcBase(payload.host || payload.pcBaseUrl || settings.pcBaseUrl);
    const typed = String(payload.code || payload.pairCode || "").replace(/\D/g, "").slice(0, 6);
    const pin = typed.length === 6 ? typed : String(settings.pairCode || "").replace(/\D/g, "").slice(0, 6);
    if (!base) throw new Error("Informe o IP do PC.");
    if (pin.length !== 6) throw new Error("O código tem 6 dígitos (só na primeira vez).");
    settings.pcBaseUrl = base;
    settings.pairCode = pin;
    await persistSettings();
    cache.seededFromPc = false;
    await persistCache();
    try {
      return await pullPcState();
    } catch (error) {
      throw new Error(error.message || PC_OFF_MSG);
    }
  }

  async function reseedFromPc() {
    return syncNow({ reseed: true });
  }

  async function disconnectPc() {
    await bootPromise;
    settings.pcBaseUrl = "";
    settings.pairCode = "";
    cache.fromPc = false;
    await persistSettings();
    await persistCache();
    return getStateSync();
  }

  async function openUrl(url) {
    const href = String(url || "").trim();
    if (!href || href === "#") return;
    try {
      if (Browser && Browser.open) {
        await Browser.open({ url: href });
        return;
      }
    } catch {
      // fallback
    }
    window.open(href, "_blank", "noopener");
  }

  window.steamApp = {
    getState: async () => {
      await bootPromise;
      return getStateSync();
    },
    saveSettings: (partial) => saveSettings(partial || {}),
    login,
    logout,
    sync: () => syncNow(),
    createShortcuts: async () => ({
      ok: false,
      message: "Atalhos da área de trabalho são só no Windows.",
    }),
    pickIcon: async () => ({ ok: false, canceled: true, message: "No celular o ícone é o do APK." }),
    resetIcon: async () => ({ ok: false, message: "No celular o ícone é o do APK." }),
    toggleSkipped,
    connectPc,
    disconnectPc,
    reseedFromPc,
    hide: () => {},
    openUrl,
    onSync: (handler) => {
      syncListeners.add(handler);
      return () => syncListeners.delete(handler);
    },
  };

  bootPromise = (async () => {
    await loadAll();
    try {
      if (StatusBar && StatusBar.setBackgroundColor) {
        await StatusBar.setBackgroundColor({ color: "#12161d" });
      }
      if (StatusBar && StatusBar.setStyle) {
        await StatusBar.setStyle({ style: "DARK" });
      }
    } catch {
      // sem status bar
    }
    if (App && App.addListener) {
      try {
        App.addListener("appUrlOpen", async (event) => {
          const href = String(event?.url || "");
          const steamId = extractSteamId64(href) || extractSteamId64(decodeURIComponent(href));
          if (!steamId) return;
          settings.steamId = steamId;
          settings.profileUrl = `https://steamcommunity.com/profiles/${steamId}`;
          settings.pendingSync = true;
          await persistSettings();
          emitSync({ syncing: false, state: getStateSync() });
          syncNow().catch(() => {});
        });
        App.addListener("appStateChange", (event) => {
          if (!event?.isActive) return;
          const hours = Math.max(1, Number(settings.syncEveryHours) || 12);
          const last = Date.parse(cache.lastSyncAt || 0);
          if (!last || Date.now() - last >= hours * 60 * 60 * 1000) {
            syncNow().catch(() => {});
          }
        });
      } catch {
        // sem deep link
      }
    }
    if (isPaired()) {
      settings.pendingSync = false;
      await persistSettings();
      setTimeout(() => {
        syncNow().catch(() => {});
      }, 400);
    } else if (settings.pendingSync && (settings.steamId || settings.profileUrl)) {
      settings.pendingSync = false;
      await persistSettings();
      setTimeout(() => {
        syncNow().catch(() => {});
      }, 400);
    }
  })();
})();
