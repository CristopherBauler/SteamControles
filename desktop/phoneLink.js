/**
 * Servidor HTTP local (LAN) para o celular puxar o mesmo estado do PC.
 * Só sobe quando o usuário liga "Conectar celular". Exige código de pareamento.
 */
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 17331;
const APP_NAME = "Minha Loja dos Desejos";

let server = null;
let pairCode = "";
let enabled = false;
let getStateFn = async () => ({});
let applySkipFn = async () => {};
const failByIp = new Map();

function persistPath() {
  const home = process.env.STEAM_CONTROLES_HOME || path.resolve(__dirname, "..");
  return path.join(home, "phoneLink.json");
}

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath(), "utf8"));
    return {
      enabled: Boolean(raw.enabled),
      code: String(raw.code || "").replace(/\D/g, "").slice(0, 6),
    };
  } catch {
    return { enabled: false, code: "" };
  }
}

function savePersisted() {
  try {
    fs.writeFileSync(
      persistPath(),
      JSON.stringify({ enabled, code: enabled ? pairCode : "" }, null, 2) + "\n"
    );
  } catch {
    // pasta pode ser só leitura
  }
}

function lanIPv4s() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets || {})) {
    for (const net of list || []) {
      const family = net.family === 4 || net.family === "IPv4";
      if (!family || net.internal) continue;
      const ip = String(net.address || "");
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
      if (ip.startsWith("169.254.")) continue;
      ips.push(ip);
    }
  }
  const rank = (ip) => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return [...new Set(ips)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function randomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function pairUrl(ip) {
  return `http://${ip}:${PORT}/pair?code=${pairCode}`;
}

function codeMatches(provided) {
  const a = String(provided || "").replace(/\s/g, "");
  const b = String(pairCode || "");
  const left = Buffer.from(a.padEnd(32, "\0"));
  const right = Buffer.from(b.padEnd(32, "\0"));
  const equal = crypto.timingSafeEqual(left, right);
  return equal && a.length === b.length && a.length === 6;
}

function requestCode(req, url) {
  const header = String(req.headers["x-pair-code"] || "").trim();
  const query = String(url.searchParams.get("code") || "").trim();
  const auth = String(req.headers.authorization || "");
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  return header || query || bearer;
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || "unknown");
}

function tooManyFails(ip) {
  const now = Date.now();
  const row = failByIp.get(ip);
  if (!row) return false;
  row.at = row.at.filter((t) => now - t < 10 * 60 * 1000);
  return row.at.length >= 20;
}

function noteFail(ip) {
  const row = failByIp.get(ip) || { at: [] };
  row.at.push(Date.now());
  failByIp.set(ip, row);
}

function send(res, status, payload, extraHeaders = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const type = typeof payload === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "X-Pair-Code, Authorization, Content-Type",
    ...extraHeaders,
  });
  res.end(body);
}

function pairPage(ok, ip) {
  const urls = lanIPv4s().map(pairUrl);
  if (!ok) {
    return `<!doctype html><meta charset="utf-8"><title>${APP_NAME}</title>
<body style="font-family:sans-serif;background:#12161d;color:#f4f7fb;padding:24px">
<h1>Código inválido</h1>
<p>Abra o app no PC em Ajustes → Conectar celular e use o código atual.</p>
</body>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Parear · ${APP_NAME}</title>
<body style="font-family:sans-serif;background:#12161d;color:#f4f7fb;padding:24px;max-width:28rem">
<h1>Parear celular</h1>
<p>No app <b>${APP_NAME}</b> (mesmo Wi‑Fi): Ajustes → cole o <b>IP do PC</b> e o <b>código</b>.</p>
<p>IP: <b>${ip || lanIPv4s()[0] || "—"}</b></p>
<p>Código: <b style="letter-spacing:.3em;font-size:1.4rem">${pairCode}</b></p>
<p style="word-break:break-all;color:#8b95a7">${urls[0] || ""}</p>
<p>O código fica salvo no celular. Depois é só <b>Atualizar agora</b> nos dois. Sem senha da Steam neste link.</p>
</body>`;
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Pedido grande demais."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

function skipChangesFromBody(body) {
  const src = body && typeof body === "object" ? body : {};
  const list = Array.isArray(src.changes) ? src.changes : [src];
  return list
    .map((item) => ({
      appId: Number(item?.appId),
      skipped: Boolean(item?.skipped),
    }))
    .filter((item) => Number.isInteger(item.appId) && item.appId > 0);
}

function compactGame(game) {
  if (!game || typeof game !== "object") return null;
  const appId = Number(game.appId);
  if (!Number.isInteger(appId) || appId <= 0) return null;
  return {
    appId,
    name: game.name || `App ${appId}`,
    headerImage: game.headerImage || game.cover || "",
    cover: game.cover || game.headerImage || "",
    currentPrice: game.currentPrice ?? null,
    discount: Number(game.discount) || 0,
    storeUrl: game.storeUrl || "",
    hours: Number(game.hours) || 0,
    family: Boolean(game.family),
    reviewPercent: game.reviewPercent != null && Number.isFinite(Number(game.reviewPercent)) ? Number(game.reviewPercent) : null,
    reviewTotal: Number(game.reviewTotal) || 0,
    unreleased: Boolean(game.unreleased),
    comingSoon: Boolean(game.comingSoon),
    isFree: Boolean(game.isFree),
    earlyAccess: Boolean(game.earlyAccess),
    releaseDate: game.releaseDate || "",
    priceLabel: game.priceLabel || "",
    genres: Array.isArray(game.genres) ? game.genres : undefined,
  };
}

function compactList(list) {
  return (Array.isArray(list) ? list : []).map(compactGame).filter(Boolean);
}

function skippedAppIdsFrom(state) {
  const src = state && typeof state === "object" ? state : {};
  const fromGames = compactList(src.skippedGames).map((game) => game.appId);
  const extra = Array.isArray(src.skippedAppIds) ? src.skippedAppIds.map(Number) : [];
  return [...new Set([...fromGames, ...extra].filter((id) => id > 0))];
}

function marksPayload(state) {
  const src = state && typeof state === "object" ? state : {};
  return {
    ok: true,
    steamId: src.steamId || "",
    profileUrl: src.profileUrl || "",
    theme: src.theme,
    skippedAppIds: skippedAppIdsFrom(src),
    lastSyncAt: src.lastSyncAt || null,
  };
}

function sanitizeState(state) {
  const src = state && typeof state === "object" ? state : {};
  return {
    steamId: src.steamId || "",
    profileUrl: src.profileUrl || "",
    steamWebApiKey: "",
    hasApiKey: false,
    syncEveryHours: src.syncEveryHours,
    startWithWindows: false,
    notifySales: src.notifySales,
    notifyNews: src.notifyNews,
    theme: src.theme,
    timezone: src.timezone,
    syncing: false,
    lastSyncAt: src.lastSyncAt,
    nextSyncAt: src.nextSyncAt,
    wishCount: src.wishCount,
    onSale: src.onSale,
    comingCount: src.comingCount,
    fullCount: src.fullCount,
    eaCount: src.eaCount ?? src.aaCount,
    backlogOpen: src.backlogOpen,
    backlogDone: src.backlogDone,
    libraryGames: compactList(src.libraryGames),
    skippedGames: compactList(src.skippedGames),
    libraryMeta: src.libraryMeta || {},
    novidadesHtml: src.novidadesHtml || "",
    lojaHtml: src.lojaHtml || "",
    games: compactList(src.games),
    skippedAppIds: skippedAppIdsFrom(src),
    backlogSort: src.backlogSort,
    fromPc: true,
    seed: true,
  };
}

async function onRequest(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    send(res, 405, { ok: false, error: "Só GET ou POST." });
    return;
  }
  let url;
  try {
    url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  } catch {
    send(res, 400, { ok: false, error: "URL inválida." });
    return;
  }
  const ip = clientIp(req);
  if (tooManyFails(ip)) {
    send(res, 429, { ok: false, error: "Muitas tentativas. Espere alguns minutos." });
    return;
  }
  const code = requestCode(req, url);
  if (!enabled || !pairCode || !codeMatches(code)) {
    noteFail(ip);
    if (url.pathname === "/pair" && method === "GET") {
      send(res, 401, pairPage(false));
      return;
    }
    send(res, 401, { ok: false, error: "Código inválido." });
    return;
  }
  if ((url.pathname === "/health" || url.pathname === "/") && method === "GET") {
    send(res, 200, { ok: true, app: APP_NAME, port: PORT });
    return;
  }
  if (url.pathname === "/pair" && method === "GET") {
    const hinted = String(url.searchParams.get("ip") || lanIPv4s()[0] || "");
    send(res, 200, pairPage(true, hinted));
    return;
  }
  if (url.pathname === "/state" && method === "GET") {
    try {
      const state = sanitizeState(await getStateFn());
      send(res, 200, state);
    } catch (error) {
      send(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if ((url.pathname === "/marks" || url.pathname === "/skips") && method === "GET") {
    try {
      send(res, 200, marksPayload(await getStateFn()));
    } catch (error) {
      send(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if ((url.pathname === "/skip" || url.pathname === "/skips") && method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      send(res, 400, { ok: false, error: error.message || "JSON inválido." });
      return;
    }
    try {
      for (const change of skipChangesFromBody(body)) {
        await applySkipFn(change.appId, change.skipped);
      }
      send(res, 200, marksPayload(await getStateFn()));
    } catch (error) {
      send(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  send(res, 404, { ok: false, error: "Não achei essa rota." });
}

function statusPayload() {
  const ips = lanIPv4s();
  return {
    enabled,
    port: PORT,
    code: enabled ? pairCode : "",
    ips,
    urls: enabled ? ips.map(pairUrl) : [],
    hint:
      "Primeira vez: o celular puxa o PC inteiro. Depois cada um atualiza a Steam sozinho. Marcas de Não vou jogar sobem e descem neste Wi‑Fi. Firewall: permita o app na rede privada. Não abra esta porta na internet.",
  };
}

function startServer() {
  if (server) return Promise.resolve(statusPayload());
  return new Promise((resolve, reject) => {
    const next = http.createServer(onRequest);
    next.on("error", (error) => {
      server = null;
      enabled = false;
      reject(error);
    });
    next.listen(PORT, "0.0.0.0", () => {
      server = next;
      enabled = true;
      savePersisted();
      resolve(statusPayload());
    });
  });
}

function bindPhoneLink(getState, applySkip) {
  if (typeof getState === "function") getStateFn = getState;
  if (typeof applySkip === "function") applySkipFn = applySkip;
}

async function startPhoneLink(getState, applySkip) {
  bindPhoneLink(getState, applySkip);
  if (server && enabled) return statusPayload();
  if (!pairCode) pairCode = randomCode();
  return startServer();
}

function stopPhoneLink() {
  enabled = false;
  pairCode = "";
  const current = server;
  server = null;
  savePersisted();
  if (!current) return statusPayload();
  try {
    current.close();
  } catch {
    // já fechou
  }
  return statusPayload();
}

async function restorePhoneLink(getState, applySkip) {
  bindPhoneLink(getState, applySkip);
  const saved = loadPersisted();
  if (!saved.enabled || saved.code.length !== 6) return statusPayload();
  pairCode = saved.code;
  try {
    return await startServer();
  } catch {
    enabled = false;
    return statusPayload();
  }
}

function getPhoneLinkStatus() {
  return statusPayload();
}

function isPhoneLinkOn() {
  return Boolean(enabled && server);
}

module.exports = {
  PORT,
  startPhoneLink,
  stopPhoneLink,
  restorePhoneLink,
  getPhoneLinkStatus,
  isPhoneLinkOn,
};
