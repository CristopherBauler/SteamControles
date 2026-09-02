/**
 * Cópia silenciosa das marcações/config no AppData + exportar/importar pela UI.
 * O usuário não precisa abrir JSON. Desinstalar o atalho não apaga isso.
 *
 * Regra: cópia vazia nunca sobrescreve cópia cheia. O exe empacotado e o
 * `npm run app` do vault não podem apagar o backlog um do outro.
 */

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { readJson, writeJson, DEFAULT_THEME, normalizeTheme } = require("./config");

const MIRROR_NAME = "MinhaLojaDosDesejos";

function mirrorRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, MIRROR_NAME);
}

function mirrorPaths() {
  const root = mirrorRoot();
  return {
    root,
    backlogDone: path.join(root, "backlogDone.json"),
    backlogTracked: path.join(root, "backlogTracked.json"),
    settings: path.join(root, "settings.json"),
    sourceHint: path.join(root, "source.json"),
  };
}

function countIds(raw) {
  const ids = raw?.appIds;
  return Array.isArray(ids) ? ids.filter((id) => Number(id) > 0).length : 0;
}

function countNamed(raw) {
  const names = raw?.names && typeof raw.names === "object" ? raw.names : {};
  return Object.values(names).filter((row) => row && String(row.name || "").trim() && !/^App\s+\d+$/i.test(row.name)).length;
}

function countGamesMap(raw) {
  if (Array.isArray(raw?.games)) return raw.games.length;
  if (raw?.games && typeof raw.games === "object") return Object.keys(raw.games).length;
  return 0;
}

function countDeals(raw) {
  return (Array.isArray(raw?.newDeals) ? raw.newDeals.length : 0) + (Array.isArray(raw?.bestDeals) ? raw.bestDeals.length : 0);
}

function listsRichness(lists) {
  if (!lists || typeof lists !== "object") return 0;
  const nLists = Array.isArray(lists.lists) ? lists.lists.length : 0;
  const nPins = lists.pins && typeof lists.pins === "object" ? Object.keys(lists.pins).length : 0;
  return nLists * 10 + nPins;
}

function themeLooksDefault(theme) {
  const t = normalizeTheme(theme);
  const d = normalizeTheme(DEFAULT_THEME);
  return t.general === d.general && t.button === d.button && TAB_KEYS.every((id) => t.tabs[id] === d.tabs[id]);
}

const TAB_KEYS = ["novidades", "wishlist", "loja", "jogos", "backlog"];

function layoutRichness(layout) {
  return layout && typeof layout === "object" ? Object.keys(layout).length : 0;
}

async function copyIfPresent(from, to) {
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

async function readSourceHint() {
  const hint = await readJson(mirrorPaths().sourceHint, null);
  if (!hint || typeof hint !== "object") return null;
  return {
    dataDir: String(hint.dataDir || "").trim(),
    configPath: String(hint.configPath || "").trim(),
  };
}

async function writeSourceHint(config, { packaged = false } = {}) {
  if (packaged) return;
  const dataDir = config?.paths?.data;
  const configPath = config?.paths?.config;
  if (!dataDir) return;
  await writeJson(mirrorPaths().sourceHint, {
    updatedAt: new Date().toISOString(),
    dataDir,
    configPath: configPath || "",
  });
}

async function collectDonorRoots(config) {
  const roots = [];
  const seen = new Set();
  const add = (dataDir, configPath) => {
    if (!dataDir) return;
    if (samePath(dataDir, config?.paths?.data)) return;
    const key = path.resolve(dataDir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({
      dataDir,
      configPath: configPath || path.join(path.dirname(dataDir), "config.json"),
    });
  };

  const mirror = mirrorPaths();
  add(mirror.root, mirror.settings);

  const hint = await readSourceHint();
  if (hint?.dataDir) add(hint.dataDir, hint.configPath);

  return roots;
}

async function pickRichestDone(local, donors) {
  let best = local && typeof local === "object" ? local : { appIds: [], games: {} };
  let bestScore = countIds(best);
  for (const donor of donors) {
    const candidate = await readJson(path.join(donor.dataDir, "backlogDone.json"), null);
    const score = countIds(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

async function hydrateJsonIfRicher(localPath, donorFiles, scoreFn) {
  const local = await readJson(localPath, null);
  let best = local;
  let bestScore = scoreFn(local);
  let from = null;
  for (const file of donorFiles) {
    if (samePath(file, localPath)) continue;
    const candidate = await readJson(file, null);
    const score = scoreFn(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      from = file;
    }
  }
  if (from && best && bestScore > scoreFn(local)) {
    await writeJson(localPath, best);
    return true;
  }
  return false;
}

function placeholderName(name) {
  return !String(name || "").trim() || /^App\s+\d+$/i.test(String(name));
}

async function fillWishlistNames(localPath, donorFiles) {
  const local = await readJson(localPath, null);
  if (!local || !Array.isArray(local.games) || !local.games.length) return false;
  const names = new Map();
  for (const file of donorFiles) {
    const donor = await readJson(file, null);
    for (const game of donor?.games || []) {
      const id = Number(game?.appId);
      if (!id || placeholderName(game.name)) continue;
      if (!names.has(id)) names.set(id, game);
    }
  }
  if (!names.size) return false;
  let changed = 0;
  for (const game of local.games) {
    const hit = names.get(Number(game.appId));
    if (!hit) continue;
    if (placeholderName(game.name) && hit.name) {
      game.name = hit.name;
      changed += 1;
    }
    if (!game.headerImage && hit.headerImage) game.headerImage = hit.headerImage;
  }
  if (!changed) return false;
  await writeJson(localPath, local);
  return true;
}

function settingsFromConfig(config) {
  return {
    updatedAt: new Date().toISOString(),
    steamId: config.steamId || "",
    profileUrl: config.profileUrl || "",
    syncEveryHours: config.syncEveryHours,
    startWithWindows: config.startWithWindows,
    notifySales: config.notifySales,
    notifyNews: config.notifyNews,
    theme: config.theme,
    layout: config.layout && typeof config.layout === "object" ? config.layout : {},
    libraryLists:
      config.libraryLists && typeof config.libraryLists === "object" ? config.libraryLists : { lists: [], pins: {} },
    backlogSort: ["hours", "reviews", "name"].includes(config.backlogSort) ? config.backlogSort : "hours",
    hasApiKey: Boolean(config.steamWebApiKey),
  };
}

async function hydrateSettings(config, donors) {
  const configPath = config?.paths?.config;
  if (!configPath) return false;
  const current = await readJson(configPath, {});
  let next = { ...current };
  let changed = false;

  for (const donor of donors) {
    const file = donor.configPath;
    if (!file || samePath(file, configPath) || !(await pathExists(file))) continue;
    const other = await readJson(file, null);
    if (!other || typeof other !== "object") continue;

    if ((!next.steamId && other.steamId) || (!next.profileUrl && other.profileUrl)) {
      if (other.steamId) next.steamId = other.steamId;
      if (other.profileUrl) next.profileUrl = other.profileUrl;
      changed = true;
    }
    if (themeLooksDefault(next.theme) && other.theme && !themeLooksDefault(other.theme)) {
      next.theme = other.theme;
      changed = true;
    }
    if (listsRichness(other.libraryLists) > listsRichness(next.libraryLists)) {
      next.libraryLists = {
        ...other.libraryLists,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
    if (layoutRichness(other.layout) > layoutRichness(next.layout)) {
      next.layout = other.layout;
      changed = true;
    }
    if ((!next.backlogSort || next.backlogSort === "hours") && other.backlogSort && other.backlogSort !== "hours") {
      next.backlogSort = other.backlogSort;
      changed = true;
    }
  }

  if (!changed) return false;
  await writeJson(configPath, next);
  return true;
}

async function hydrateUserData(config, options = {}) {
  const { paths } = config || {};
  if (!paths) return;
  const mirror = mirrorPaths();
  await fs.mkdir(mirror.root, { recursive: true });

  const donors = await collectDonorRoots(config);

  const localDone = await readJson(paths.backlogDone, { appIds: [], games: {} });
  const richest = await pickRichestDone(localDone, donors);
  if (countIds(richest) > countIds(localDone)) {
    await writeJson(paths.backlogDone, richest);
  }

  const dataFiles = (name) => donors.map((donor) => path.join(donor.dataDir, name));

  await hydrateJsonIfRicher(paths.backlogTracked, dataFiles("backlogTracked.json"), countGamesMap);
  if (paths.libraryReviews) {
    await hydrateJsonIfRicher(paths.libraryReviews, dataFiles("libraryReviews.json"), countGamesMap);
  }
  const appNames = path.join(paths.data, "appNames.json");
  await hydrateJsonIfRicher(appNames, dataFiles("appNames.json"), countNamed);
  if (paths.ggDeals) {
    await hydrateJsonIfRicher(paths.ggDeals, dataFiles("ggDeals.json"), countDeals);
  }
  if (paths.storeHub) {
    await hydrateJsonIfRicher(paths.storeHub, dataFiles("storeHub.json"), countDeals);
  }
  if (paths.wishlist) {
    await fillWishlistNames(paths.wishlist, dataFiles("wishlist.json"));
  }

  await hydrateSettings(config, donors);
  await writeSourceHint(config, options);
}

async function mirrorBacklogFiles(paths, { allowEmpty = false } = {}) {
  if (!paths) return;
  const mirror = mirrorPaths();
  await fs.mkdir(mirror.root, { recursive: true });

  const localDone = await readJson(paths.backlogDone, { appIds: [], games: {} });
  const mirrorDone = await readJson(mirror.backlogDone, { appIds: [], games: {} });
  const localCount = countIds(localDone);
  const mirrorCount = countIds(mirrorDone);
  if (localCount > 0 || allowEmpty || localCount >= mirrorCount) {
    await copyIfPresent(paths.backlogDone, mirror.backlogDone);
  }

  const localTracked = await readJson(paths.backlogTracked, null);
  const mirrorTracked = await readJson(mirror.backlogTracked, null);
  if (countGamesMap(localTracked) >= countGamesMap(mirrorTracked)) {
    await copyIfPresent(paths.backlogTracked, mirror.backlogTracked);
  }
}

async function mirrorUserData(config, options = {}) {
  if (!config?.paths) return;
  await mirrorBacklogFiles(config.paths, options);
  await writeSourceHint(config, options);
  const mirror = mirrorPaths();
  const incoming = settingsFromConfig(config);
  const existing = await readJson(mirror.settings, null);
  const next = existing && typeof existing === "object" ? { ...existing, ...incoming } : incoming;
  if (themeLooksDefault(incoming.theme) && existing && !themeLooksDefault(existing.theme)) {
    next.theme = existing.theme;
  }
  if (listsRichness(incoming.libraryLists) < listsRichness(existing?.libraryLists)) {
    next.libraryLists = existing.libraryLists;
  }
  if (layoutRichness(incoming.layout) < layoutRichness(existing?.layout)) {
    next.layout = existing.layout;
  }
  await writeJson(mirror.settings, next);
}

async function buildExportPayload(config) {
  const { paths } = config;
  const done = await readJson(paths.backlogDone, { appIds: [], games: {} });
  const tracked = await readJson(paths.backlogTracked, { games: {} });
  return {
    kind: "minha-loja-dos-desejos-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    steamId: config.steamId || "",
    profileUrl: config.profileUrl || "",
    syncEveryHours: config.syncEveryHours,
    startWithWindows: config.startWithWindows,
    notifySales: config.notifySales,
    notifyNews: config.notifyNews,
    theme: config.theme,
    layout: config.layout && typeof config.layout === "object" ? config.layout : {},
    libraryLists:
      config.libraryLists && typeof config.libraryLists === "object" ? config.libraryLists : { lists: [], pins: {} },
    backlogSort: ["hours", "reviews", "name"].includes(config.backlogSort) ? config.backlogSort : "hours",
    steamWebApiKey: config.steamWebApiKey || "",
    backlogDone: done,
    backlogTracked: tracked,
  };
}

function isBackupPayload(data) {
  return Boolean(data && data.kind === "minha-loja-dos-desejos-backup" && data.version);
}

async function applyImportPayload(config, data) {
  if (!isBackupPayload(data)) {
    throw new Error("Arquivo de cópia inválido.");
  }
  const { paths } = config;
  if (data.backlogDone) await writeJson(paths.backlogDone, data.backlogDone);
  if (data.backlogTracked) await writeJson(paths.backlogTracked, data.backlogTracked);
  await mirrorUserData(config, { allowEmpty: true });
  return {
    skipped: countIds(data.backlogDone),
  };
}

module.exports = {
  mirrorRoot,
  hydrateUserData,
  mirrorUserData,
  mirrorBacklogFiles,
  buildExportPayload,
  applyImportPayload,
  isBackupPayload,
};
