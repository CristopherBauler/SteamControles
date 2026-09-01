const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

const APP_TITLE = "Minha Loja dos Desejos";

// AUMID must be set before any window is created so Windows groups/pins
// this app instead of electron.exe / Windows Script Host.
app.setAppUserModelId("dev.steamcontroles.app");
app.setName(APP_TITLE);

process.env.STEAM_CONTROLES_HOME = app.isPackaged
  ? app.getPath("userData")
  : path.resolve(__dirname, "..");

const { loadConfig, readJson, writeJson, CONFIG_PATH, DEFAULT_CONFIG, normalizeTheme, formatBRL } = require("../Scripts/config");
const { run } = require("../Scripts/updateWishlist");
const { loginWithSteam } = require("../Scripts/steamLogin");
const { isUnreleased, updatesBanner, storePageHtml } = require("../Scripts/dashboard");
const { detectEarlyAccess } = require("../Scripts/steamApi");
const { loadLibraryLists, toggleSkipped } = require("../Scripts/backlog");
const { startPhoneLink, stopPhoneLink, restorePhoneLink, getPhoneLinkStatus } = require("./phoneLink");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const APP_AUMID = "dev.steamcontroles.app";
const APP_VERSION = require("../package.json").version;
const APK_RELEASES_URL = "https://github.com/CristopherBauler/SteamControles/releases";

const HOUR_MS = 60 * 60 * 1000;
let mainWindow = null;
let tray = null;
let syncing = false;
let syncProgress = null;
let lastProgressSentAt = 0;
let syncTimer = null;
let lastSyncAt = null;
let nextSyncAt = null;

function iconFiles() {
  return {
    png: path.join(__dirname, "icon.png"),
    ico: path.join(__dirname, "icon.ico"),
    fallback: path.join(__dirname, "icon-default.png"),
  };
}

const ICO_SIZES = [16, 32, 48, 256];

function andMaskStride(width) {
  return ((width + 31) >> 5) << 2;
}

function bitmapToIcoDib(width, height, bgraTopDown) {
  const xorStride = width * 4;
  const xorSize = xorStride * height;
  const andSize = andMaskStride(width) * height;
  const headerSize = 40;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(xorSize, 20);
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * xorStride;
    bgraTopDown.copy(buf, headerSize + y * xorStride, srcStart, srcStart + xorStride);
  }
  return buf;
}

function imageToIco(image) {
  const images = ICO_SIZES.map((size) => {
    const resized = image.resize({ width: size, height: size, quality: "best" });
    const { width, height } = resized.getSize();
    return {
      size,
      dib: bitmapToIcoDib(width || size, height || size, resized.toBitmap()),
    };
  });
  const dirSize = 6 + 16 * images.length;
  let offset = dirSize;
  const header = Buffer.alloc(dirSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const parts = [header];
  images.forEach((entry, i) => {
    const pos = 6 + i * 16;
    const dim = entry.size >= 256 ? 0 : entry.size;
    header.writeUInt8(dim, pos);
    header.writeUInt8(dim, pos + 1);
    header.writeUInt8(0, pos + 2);
    header.writeUInt8(0, pos + 3);
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(entry.dib.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += entry.dib.length;
    parts.push(entry.dib);
  });
  return Buffer.concat(parts);
}

function icoNeedsRebuild(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length < 24) return true;
    const count = bytes.readUInt16LE(4);
    const png = bytes[22] === 0x89 && bytes[23] === 0x50 && bytes[24] === 0x4e;
    return count < 2 || png;
  } catch {
    return true;
  }
}

function ensureWindowsIcon() {
  const files = iconFiles();
  const source = [files.png, files.fallback].find((file) => fs.existsSync(file));
  if (!source) return;
  if (fs.existsSync(files.ico) && !icoNeedsRebuild(files.ico)) return;
  try {
    const loaded = nativeImage.createFromPath(source);
    if (loaded.isEmpty()) return;
    fs.writeFileSync(files.ico, imageToIco(squareIcon(loaded)));
  } catch {
    // keep whatever icon files already exist
  }
}

function squareIcon(image) {
  const { width, height } = image.getSize();
  const side = Math.min(width, height) || 256;
  return image
    .crop({
      x: Math.max(0, Math.floor((width - side) / 2)),
      y: Math.max(0, Math.floor((height - side) / 2)),
      width: side,
      height: side,
    })
    .resize({ width: 256, height: 256, quality: "best" });
}

function writeIconFiles(image) {
  const png = image.toPNG();
  const files = iconFiles();
  fs.writeFileSync(files.png, png);
  fs.writeFileSync(files.ico, imageToIco(image));
}

function windowIcon() {
  const ico = shortcutIconPath();
  if (ico) return ico;
  return iconImage();
}

function applyLiveIcon(image) {
  const next = shortcutIconPath() || image;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(next);
  if (tray && !tray.isDestroyed()) tray.setImage(next);
}

function iconImage() {
  const files = iconFiles();
  for (const file of [files.ico, files.png, files.fallback]) {
    if (!fs.existsSync(file)) continue;
    try {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image;
    } catch {
      // try next
    }
  }
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANUlEQVR4nO3OsQkAMAwDQf9/6pQqQ0jQ4d1BM4CqZgAAAAAAAAAAAAAAAAAAAAAAAADwsQMk1gEh6pOqJgAAAABJRU5ErkJggg=="
  );
}

function shortcutIconPath() {
  if (app.isPackaged) return process.execPath;
  const files = iconFiles();
  if (fs.existsSync(files.ico)) return files.ico;
  return "";
}

function shortcutSpec() {
  const root = PROJECT_ROOT;
  const icon = shortcutIconPath();
  if (app.isPackaged) {
    return {
      target: process.execPath,
      args: "",
      cwd: path.dirname(process.execPath),
      icon,
    };
  }
  const distExe = path.join(root, "dist", "SteamControles.exe");
  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const cmd = path.join(root, "SteamControles.cmd");
  const vbs = path.join(root, "SteamControles.vbs");
  if (fs.existsSync(distExe)) {
    return { target: distExe, args: "", cwd: root, icon };
  }
  if (fs.existsSync(cmd)) {
    return { target: cmd, args: "", cwd: root, icon };
  }
  if (fs.existsSync(vbs)) {
    return { target: vbs, args: "", cwd: root, icon };
  }
  return {
    target: electronExe,
    args: `"${root}"`,
    cwd: root,
    icon,
  };
}

async function applyIconFromPath(filePath) {
  const loaded = nativeImage.createFromPath(filePath);
  if (loaded.isEmpty()) {
    return { ok: false, message: "Não consegui ler essa imagem. Tente PNG, JPG ou ICO." };
  }
  const image = squareIcon(loaded);
  writeIconFiles(image);
  applyLiveIcon(image);
  const shortcuts = await createAppShortcuts();
  return {
    ok: true,
    message: shortcuts.ok
      ? "Ícone atualizado. Se o atalho não mudar, dê F5 na área de trabalho."
      : "Ícone do app atualizado. Recrie o atalho se a área de trabalho não mudar.",
  };
}

function writeAppShortcut(filePath, spec) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    target: spec.target,
    cwd: spec.cwd,
    args: spec.args || "",
    description: APP_TITLE,
    iconIndex: 0,
    appUserModelId: APP_AUMID,
  };
  if (spec.icon) payload.icon = spec.icon;
  return shell.writeShortcutLink(filePath, payload);
}

async function createAppShortcuts() {
  const spec = shortcutSpec();
  if (!spec.target || !fs.existsSync(spec.target)) {
    return {
      ok: false,
      message: `Não achei o SteamControles.exe nem o launcher. Rode npm run app:build ou npm install.`,
    };
  }
  const desktop = path.join(app.getPath("desktop"), `${APP_TITLE}.lnk`);
  const startMenu = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APP_TITLE}.lnk`
  );
  try {
    fs.unlinkSync(path.join(app.getPath("desktop"), "SteamControles.lnk"));
  } catch {
    // old shortcut already gone
  }
  try {
    fs.unlinkSync(
      path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "SteamControles.lnk")
    );
  } catch {
    // old shortcut already gone
  }
  const desktopOk = writeAppShortcut(desktop, spec);
  const startOk = writeAppShortcut(startMenu, spec);
  if (!desktopOk && !startOk) {
    return { ok: false, message: "Não consegui gravar o atalho. Tente de novo como administrador." };
  }
  const bits = [];
  if (desktopOk) bits.push("Área de trabalho");
  if (startOk) bits.push("Menu Iniciar");
  return {
    ok: true,
    desktop: desktopOk ? desktop : "",
    startMenu: startOk ? startMenu : "",
    target: spec.target,
    message: `Atalho criado em ${bits.join(" e ")}. Fixe o atalho ${APP_TITLE} — não o electron.exe nem o .vbs.`,
  };
}

function bindWindowIcon(win) {
  const apply = () => {
    if (!win || win.isDestroyed()) return;
    win.setIcon(windowIcon());
  };
  win.webContents.on("did-finish-load", apply);
  win.once("ready-to-show", apply);
}

function applyWindowTitle(win) {
  if (!win || win.isDestroyed()) return;
  win.setTitle(APP_TITLE);
}

function bindWindowTitle(win) {
  applyWindowTitle(win);
  win.webContents.on("did-finish-load", () => applyWindowTitle(win));
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    applyWindowTitle(win);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    title: APP_TITLE,
    show: !process.argv.includes("--hidden"),
    backgroundColor: "#12161d",
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setTitle(APP_TITLE);
  bindWindowIcon(mainWindow);
  bindWindowTitle(mainWindow);
  try {
    const spec = shortcutSpec();
    const relaunch = spec.target
      ? spec.args
        ? `"${spec.target}" ${spec.args}`
        : `"${spec.target}"`
      : "";
    const ico = shortcutIconPath();
    if (relaunch && ico) {
      mainWindow.setAppDetails({
        appId: APP_AUMID,
        appIconPath: ico,
        appIconIndex: 0,
        relaunchCommand: relaunch,
        relaunchDisplayName: APP_TITLE,
      });
    }
  } catch {
    // setAppDetails is Windows-only
  }
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html")).then(() => {
    applyWindowTitle(mainWindow);
  });
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(windowIcon());
  updateTrayTooltip();
  tray.on("double-click", showWindow);
  rebuildTray();
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  if (syncing && syncProgress && Number.isFinite(Number(syncProgress.percent))) {
    tray.setToolTip(`${APP_TITLE} · ${syncProgress.percent}%`);
    return;
  }
  if (syncing) {
    tray.setToolTip(`${APP_TITLE} · sincronizando`);
    return;
  }
  tray.setToolTip(APP_TITLE);
}

function rebuildTray() {
  if (!tray) return;
  updateTrayTooltip();
  const next = nextSyncAt
    ? `Próximo sync ${new Date(nextSyncAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : "Sync automático 12 h";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Abrir ${APP_TITLE}`, click: showWindow },
      { label: syncing ? "Sincronizando…" : "Atualizar agora", enabled: !syncing, click: () => syncNow({ manual: true }) },
      { label: next, enabled: false },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ])
  );
}

async function getState() {
  const config = await loadConfig();
  const wishlist = await readJson(config.paths.wishlist, { games: [] });
  const updates = await readJson(config.paths.wishlistUpdates, { events: [] });
  const mostWanted = await readJson(config.paths.mostWanted, { games: [] });
  const ggPopular = await readJson(config.paths.ggPopular, { games: [] });
  const storeHub = await readJson(config.paths.storeHub, {
    events: [],
    specials: [],
    newDeals: [],
    bestDeals: [],
    dealsStrip: [],
  });
  const ggDeals = await readJson(config.paths.ggDeals, { newDeals: [], bestDeals: [] });
  const library = await loadLibraryLists(config);
  const games = (wishlist.games || []).filter((game) => game.onWishlist !== false);
  const wishAll = games.map((game) => {
    const unreleased = isUnreleased(game);
    return {
      appId: game.appId,
      name: game.name,
      headerImage: game.headerImage,
      currentPrice: game.currentPrice,
      discount: Number(game.discount) || 0,
      storeUrl: game.storeUrl,
      comingSoon: game.comingSoon,
      releaseDate: game.releaseDate || "",
      isFree: Boolean(game.isFree),
      unreleased,
      earlyAccess: detectEarlyAccess(game),
      priceLabel: formatBRL(game.currentPrice),
    };
  });
  const comingCount = wishAll.filter((game) => game.unreleased).length;
  const saleCount = wishAll.filter((game) => !game.unreleased && Number(game.discount) > 0).length;
  const fullCount = wishAll.filter((game) => !game.unreleased && !Number(game.discount)).length;
  const aaCount = wishAll.filter((game) => game.earlyAccess).length;
  return {
    steamId: config.steamId,
    profileUrl: config.profileUrl,
    steamWebApiKey: config.steamWebApiKey ? "••••" : "",
    hasApiKey: Boolean(config.steamWebApiKey),
    syncEveryHours: config.syncEveryHours,
    startWithWindows: config.startWithWindows,
    notifySales: config.notifySales,
    notifyNews: config.notifyNews,
    theme: normalizeTheme(config.theme),
    timezone: config.timezone || "America/Sao_Paulo",
    appVersion: APP_VERSION,
    apkUrl: APK_RELEASES_URL,
    syncing,
    syncPercent: syncing ? syncProgress?.percent ?? 0 : null,
    syncLabel: syncing ? syncProgress?.label || "" : "",
    lastSyncAt,
    nextSyncAt,
    packaged: app.isPackaged,
    dataPath: process.env.STEAM_CONTROLES_HOME,
    wishCount: wishAll.length,
    onSale: saleCount,
    comingCount,
    fullCount,
    aaCount,
    backlogOpen: library.open.length,
    backlogDone: library.done.length,
    libraryGames: library.open,
    skippedGames: library.done,
    libraryMeta: library.meta,
    novidadesHtml: updatesBanner(updates.events || [], config.timezone),
    lojaHtml: storePageHtml({
      mostWanted: mostWanted.games || [],
      ggPopular: ggPopular.games || [],
      storeHub,
      ggDeals,
    }),
    games: wishAll,
  };
}

async function getStateForPhone() {
  const state = await getState();
  return {
    ...state,
    steamWebApiKey: "",
    hasApiKey: false,
    dataPath: "",
    packaged: undefined,
    fromPc: true,
  };
}

async function applyPhoneSkip(appId, skipped) {
  const config = await loadConfig();
  await toggleSkipped(config, appId, skipped);
  const state = await getState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync-status", { syncing: false, state });
  }
  return state;
}

async function saveSettings(partial) {
  const current = await readJson(CONFIG_PATH, { ...DEFAULT_CONFIG });
  const next = { ...DEFAULT_CONFIG, ...current };
  if (partial.steamId != null) {
    next.steamId = String(partial.steamId).trim();
    if (partial.profileUrl == null) {
      next.profileUrl = next.steamId ? `https://steamcommunity.com/profiles/${next.steamId}` : "";
    }
  }
  if (partial.profileUrl != null) next.profileUrl = String(partial.profileUrl).trim();
  if (partial.steamWebApiKey != null && partial.steamWebApiKey !== "••••") {
    next.steamWebApiKey = String(partial.steamWebApiKey).trim();
  }
  if (partial.syncEveryHours != null) next.syncEveryHours = Number(partial.syncEveryHours) || 12;
  if (partial.startWithWindows != null) next.startWithWindows = Boolean(partial.startWithWindows);
  if (partial.notifySales != null) next.notifySales = Boolean(partial.notifySales);
  if (partial.notifyNews != null) next.notifyNews = Boolean(partial.notifyNews);
  if (partial.theme != null) {
    next.theme = normalizeTheme({
      ...next.theme,
      ...partial.theme,
      tabs: { ...(next.theme && next.theme.tabs), ...(partial.theme.tabs || {}) },
    });
  }
  if (!app.isPackaged) {
    // keep vault paths when running from the repo
  } else {
    next.vaultPath = "";
    next.projectFolder = "";
  }
  await writeJson(CONFIG_PATH, next);
  applyOpenAtLogin(next.startWithWindows);
  scheduleSync(next.syncEveryHours);
  return getState();
}

function applyOpenAtLogin(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      args: ["--hidden"],
    });
  } catch {
    // some portable builds ignore this; the tray app still runs while open
  }
}

function scheduleSync(hours) {
  const ms = Math.max(1, Number(hours) || 12) * HOUR_MS;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    syncNow({ manual: false }).catch(() => {});
  }, ms);
  nextSyncAt = Date.now() + ms;
  rebuildTray();
}

function notifySync(config, result) {
  if (!Notification.isSupported() || !result) return;
  const sales = (result.events || []).filter((event) => event.kind === "sale" || event.kind === "saleOff");
  const news = (result.events || []).filter((event) => event.kind === "news");
  if (config.notifySales && sales.length) {
    new Notification({
      title: APP_TITLE,
      body: `${sales.length} promoção(ões) na wishlist.`,
    }).show();
    return;
  }
  if (config.notifyNews && news.length) {
    new Notification({
      title: APP_TITLE,
      body: `${news.length} notícia(s) da wishlist nos últimos 7 dias.`,
    }).show();
    return;
  }
  if (result.freshCount) {
    new Notification({
      title: APP_TITLE,
      body: `Wishlist atualizada · ${result.wishCount || 0} jogos.`,
    }).show();
  }
}

async function syncNow({ manual } = {}) {
  if (syncing) return { ok: false, message: "Já está sincronizando." };
  const config = await loadConfig();
  if (!config.steamId && !config.profileUrl) {
    return { ok: false, message: "Conecte a Steam antes de sincronizar." };
  }
  syncing = true;
  syncProgress = { phase: "wishlist", label: "wishlist", current: 0, total: 0, percent: 0 };
  lastProgressSentAt = 0;
  rebuildTray();
  sendSyncProgress({ force: true });
  try {
    const result =
      (await run({
        onProgress: (payload) => applySyncProgress(payload),
      })) || {};
    lastSyncAt = new Date().toISOString();
    scheduleSync(config.syncEveryHours);
    if (!manual) notifySync(config, result);
    else {
      new Notification({
        title: APP_TITLE,
        body: `Atualizado · ${result.wishCount || 0} jogos na wishlist.`,
      }).show();
    }
    syncing = false;
    syncProgress = null;
    const state = await getState();
    if (mainWindow) mainWindow.webContents.send("sync-status", { syncing: false, state });
    return { ok: true, result, state };
  } catch (error) {
    const message = error.stack || error.message || String(error);
    if (mainWindow) mainWindow.webContents.send("sync-status", { syncing: false, error: message });
    new Notification({ title: APP_TITLE, body: "A sincronização falhou. Abra o app para ver o erro." }).show();
    return { ok: false, message };
  } finally {
    syncing = false;
    syncProgress = null;
    rebuildTray();
  }
}

function applySyncProgress(payload) {
  const prevPhase = syncProgress?.phase;
  const percent = Math.max(0, Math.min(99, Math.round(Number(payload?.percent) || 0)));
  syncProgress = {
    phase: payload?.phase || "",
    label: payload?.label || "",
    current: Number(payload?.current) || 0,
    total: Number(payload?.total) || 0,
    percent,
  };
  updateTrayTooltip();
  sendSyncProgress({ force: Boolean(payload?.phase && payload.phase !== prevPhase) });
}

function sendSyncProgress({ force } = {}) {
  if (!syncing || !syncProgress) return;
  const now = Date.now();
  if (!force && now - lastProgressSentAt < 120) return;
  lastProgressSentAt = now;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("sync-status", {
    syncing: true,
    percent: syncProgress.percent,
    phase: syncProgress.phase,
    label: syncProgress.label,
    current: syncProgress.current,
    total: syncProgress.total,
  });
}

ipcMain.handle("get-state", () => getState());
ipcMain.handle("save-settings", (_event, partial) => saveSettings(partial || {}));
ipcMain.handle("steam-login", async () => {
  const steamId = await loginWithSteam();
  return saveSettings({ steamId });
});
ipcMain.handle("logout", () => saveSettings({ steamId: "", profileUrl: "" }));
ipcMain.handle("sync-now", () => syncNow({ manual: true }));
ipcMain.handle("toggle-skipped", async (_event, payload = {}) => {
  const config = await loadConfig();
  await toggleSkipped(config, payload.appId, payload.skipped);
  return getState();
});
ipcMain.handle("create-shortcuts", () => createAppShortcuts());
ipcMain.handle("pick-icon", async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: `Escolher ícone de ${APP_TITLE}`,
    properties: ["openFile"],
    filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp", "ico"] }],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, canceled: true, message: "" };
  }
  try {
    return await applyIconFromPath(result.filePaths[0]);
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});
ipcMain.handle("phone-link-status", () => getPhoneLinkStatus());
ipcMain.handle("phone-link-start", () => startPhoneLink(getStateForPhone, applyPhoneSkip));
ipcMain.handle("phone-link-stop", () => stopPhoneLink());
ipcMain.handle("reset-icon", async () => {
  const fallback = iconFiles().fallback;
  if (!fs.existsSync(fallback)) {
    return { ok: false, message: "Não achei o ícone padrão." };
  }
  try {
    return await applyIconFromPath(fallback);
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
});
ipcMain.on("hide-window", () => {
  if (mainWindow) mainWindow.hide();
});
ipcMain.on("open-url", (_event, url) => {
  if (url) shell.openExternal(String(url));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    ensureWindowsIcon();
    await createAppShortcuts().catch(() => {});
    createWindow();
    createTray();
    const config = await loadConfig();
    applyOpenAtLogin(config.startWithWindows);
    scheduleSync(config.syncEveryHours);
    restorePhoneLink(getStateForPhone, applyPhoneSkip).catch(() => {});
    if (config.steamId || config.profileUrl) {
      setTimeout(() => syncNow({ manual: false }).catch(() => {}), 8000);
    }
  });
}

app.on("window-all-closed", () => {
  // permanece na bandeja
});
