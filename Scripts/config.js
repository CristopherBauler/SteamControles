/**
 * Carrega config.json e resolve pastas do projeto.
 */

const fs = require("fs/promises");
const path = require("path");

const PROJECT_ROOT = path.resolve(process.env.STEAM_CONTROLES_HOME || path.join(__dirname, ".."));
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

const TAB_IDS = ["novidades", "wishlist", "loja", "jogos", "backlog"];

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

const DEFAULT_CONFIG = {
  steamId: "",
  profileUrl: "",
  currency: "BRL",
  country: "br",
  language: "portuguese",
  timezone: "America/Sao_Paulo",
  updateHour: "08:00",
  vaultPath: "",
  projectFolder: "",
  requestDelayMs: 1000,
  itadApiKey: "",
  steamWebApiKey: "",
  syncEveryHours: 12,
  startWithWindows: true,
  notifySales: true,
  notifyNews: true,
  theme: { ...DEFAULT_THEME, tabs: { ...DEFAULT_THEME.tabs } },
  layout: {},
  libraryLists: { lists: [], pins: {} },
};

function normalizeHex(value, fallback) {
  const raw = String(value || "").trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    const [a, b, c] = short[1].split("");
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  if (full) return `#${full[1].toLowerCase()}`;
  return fallback;
}

function normalizeTheme(theme) {
  const src = theme && typeof theme === "object" ? theme : {};
  const tabs = src.tabs && typeof src.tabs === "object" ? src.tabs : {};
  return {
    general: normalizeHex(src.general, DEFAULT_THEME.general),
    button: normalizeHex(src.button, DEFAULT_THEME.button),
    tabs: Object.fromEntries(TAB_IDS.map((id) => [id, normalizeHex(tabs[id], DEFAULT_THEME.tabs[id])])),
  };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (arguments.length > 1 && (error.code === "ENOENT" || error instanceof SyntaxError)) {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function loadConfig() {
  let config = await readJson(CONFIG_PATH, null);
  if (!config) {
    config = { ...DEFAULT_CONFIG };
    await writeJson(CONFIG_PATH, config);
  }

  const vaultPath = config.vaultPath || (process.env.STEAM_CONTROLES_HOME ? PROJECT_ROOT : path.resolve(PROJECT_ROOT, ".."));
  const base = config.projectFolder
    ? path.join(vaultPath, config.projectFolder)
    : PROJECT_ROOT;

  return {
    steamId: String(config.steamId || "").trim(),
    profileUrl: String(config.profileUrl || "").trim(),
    currency: config.currency || "BRL",
    country: config.country || "br",
    language: config.language || "portuguese",
    timezone: config.timezone || "America/Sao_Paulo",
    updateHour: config.updateHour || "08:00",
    vaultPath,
    projectFolder: config.projectFolder || path.basename(base),
    requestDelayMs: Number(config.requestDelayMs) > 0 ? Number(config.requestDelayMs) : 1000,
    itadApiKey: String(config.itadApiKey || "").trim(),
    steamWebApiKey: String(config.steamWebApiKey || "").trim(),
    syncEveryHours: Number(config.syncEveryHours) > 0 ? Number(config.syncEveryHours) : 12,
    startWithWindows: config.startWithWindows !== false,
    notifySales: config.notifySales !== false,
    notifyNews: config.notifyNews !== false,
    theme: normalizeTheme(config.theme),
    layout: config.layout && typeof config.layout === "object" && !Array.isArray(config.layout) ? config.layout : {},
    libraryLists:
      config.libraryLists && typeof config.libraryLists === "object" && !Array.isArray(config.libraryLists)
        ? config.libraryLists
        : { lists: [], pins: {} },
    paths: {
      root: base,
      config: CONFIG_PATH,
      data: path.join(base, "Data"),
      games: path.join(base, "Games"),
      dashboard: path.join(base, "Dashboard"),
      wishlist: path.join(base, "Data", "wishlist.json"),
      history: path.join(base, "Data", "priceHistory.json"),
      targets: path.join(base, "Data", "targets.json"),
      cache: path.join(base, "Data", "cache.json"),
      owned: path.join(base, "Data", "owned.json"),
      mostWanted: path.join(base, "Data", "mostWanted.json"),
      ggPopular: path.join(base, "Data", "ggPopular.json"),
      ggDeals: path.join(base, "Data", "ggDeals.json"),
      storeHub: path.join(base, "Data", "storeHub.json"),
      wishlistUpdates: path.join(base, "Data", "wishlistUpdates.json"),
      ownedPlaytimes: path.join(base, "Data", "ownedPlaytimes.json"),
      backlogDone: path.join(base, "Data", "backlogDone.json"),
      backlogTracked: path.join(base, "Data", "backlogTracked.json"),
      libraryReviews: path.join(base, "Data", "libraryReviews.json"),
      dashboardNote: path.join(base, "Dashboard", "Steam Wishlist Dashboard.md"),
      backlogNote: path.join(base, "Dashboard", "Backlog Steam.md"),
      skippedNote: path.join(base, "Dashboard", "Não vou jogar.md"),
    },
  };
}

function todayInTimezone(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
  return Number(value).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function paint(color, text) {
  return `${ansi[color] || ""}${text}${ansi.reset}`;
}

module.exports = {
  PROJECT_ROOT,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  DEFAULT_THEME,
  normalizeTheme,
  loadConfig,
  readJson,
  writeJson,
  todayInTimezone,
  nowIso,
  roundMoney,
  centsToReais,
  formatBRL,
  sleep,
  paint,
};
