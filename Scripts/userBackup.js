/**
 * Cópia silenciosa das marcações/config no AppData + exportar/importar pela UI.
 * O usuário não precisa abrir JSON. Desinstalar o atalho não apaga isso.
 */

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { readJson, writeJson } = require("./config");

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
  };
}

function countIds(raw) {
  const ids = raw?.appIds;
  return Array.isArray(ids) ? ids.filter((id) => Number(id) > 0).length : 0;
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

async function hydrateUserData(config) {
  const { paths } = config;
  const mirror = mirrorPaths();
  await fs.mkdir(mirror.root, { recursive: true });

  const localDone = await readJson(paths.backlogDone, { appIds: [], games: {} });
  if (countIds(localDone) === 0) {
    const backup = await readJson(mirror.backlogDone, { appIds: [], games: {} });
    if (countIds(backup) > 0) {
      await writeJson(paths.backlogDone, backup);
    }
  }

  const localTracked = await readJson(paths.backlogTracked, null);
  const hasTracked = Boolean(localTracked && (localTracked.games || Array.isArray(localTracked)));
  if (!hasTracked) {
    await copyIfPresent(mirror.backlogTracked, paths.backlogTracked);
  }
}

async function mirrorBacklogFiles(paths) {
  if (!paths) return;
  const mirror = mirrorPaths();
  await fs.mkdir(mirror.root, { recursive: true });
  await copyIfPresent(paths.backlogDone, mirror.backlogDone);
  await copyIfPresent(paths.backlogTracked, mirror.backlogTracked);
}

async function mirrorUserData(config) {
  if (!config?.paths) return;
  await mirrorBacklogFiles(config.paths);
  const mirror = mirrorPaths();
  await writeJson(mirror.settings, {
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
    hasApiKey: Boolean(config.steamWebApiKey),
  });
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
  await mirrorUserData(config);
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
