/**
 * Baixa HTML com o Chromium do Electron (cookies, JS, TLS iguais ao Chrome).
 * Node fetch no gg.deals leva 403 do Cloudflare; esta janela precisa pintar
 * (mesmo fora da tela) para o desafio completar. Reusa persist:ggdeals.
 */

const path = require("path");
const { BrowserWindow, session, app, screen } = require("electron");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BLOCKED = /just a moment|cf-browser-verification|challenge-platform|attention required/i;

let scrapeWin = null;
let scrapeLock = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady() {
  if (app.isReady()) return;
  await app.whenReady();
}

function looksBlocked(html, title) {
  return BLOCKED.test(String(html || "")) || BLOCKED.test(String(title || ""));
}

function scrapeBounds(onScreen) {
  try {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    if (onScreen) {
      return {
        x: x + Math.max(40, width - 1120),
        y: y + Math.max(40, height - 780),
        width: 1080,
        height: 720,
      };
    }
    return { x: x + width + 120, y, width: 1440, height: 960 };
  } catch {
    return onScreen
      ? { x: 80, y: 80, width: 1080, height: 720 }
      : { x: -1800, y: 0, width: 1440, height: 960 };
  }
}

let headersHooked = false;

async function getScrapeWin() {
  await waitForReady();
  if (scrapeWin && !scrapeWin.isDestroyed()) {
    wakeScrapeWin(scrapeWin, false);
    return scrapeWin;
  }
  const ses = session.fromPartition("persist:ggdeals");
  try {
    ses.setUserAgent(UA);
  } catch {
    // Electron antigo
  }
  if (!headersHooked) {
    headersHooked = true;
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = {
        ...details.requestHeaders,
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "User-Agent": UA,
      };
      callback({ requestHeaders });
    });
  }
  const box = scrapeBounds(false);
  scrapeWin = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    focusable: true,
    title: "Minha Loja dos Desejos · gg.deals",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: ses,
      preload: path.join(__dirname, "ggPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  scrapeWin.setMenuBarVisibility(false);
  scrapeWin.webContents.setBackgroundThrottling(false);
  scrapeWin.webContents.setUserAgent(UA);
  scrapeWin.on("closed", () => {
    scrapeWin = null;
  });
  wakeScrapeWin(scrapeWin, false);
  return scrapeWin;
}

function wakeScrapeWin(win, onScreen) {
  try {
    const box = scrapeBounds(Boolean(onScreen));
    win.setBounds(box);
    win.setOpacity(1);
    if (onScreen) {
      win.show();
    } else {
      win.showInactive();
    }
  } catch {
    // ignore
  }
}

function restScrapeWin(win) {
  try {
    if (win && !win.isDestroyed()) win.hide();
  } catch {
    // ignore
  }
}

const EXTRACT_JS = `(() => {
  const topText = (document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 2500) : "");
  const blocked = /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(topText);
  const headings = [...document.querySelectorAll("h1,h2,h3,h4")].map((el) => ({
    el,
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
  }));
  const kindOf = (text) => {
    if (/Most Popular Games/i.test(text)) return "popular";
    if (/New (game )?deals/i.test(text)) return "newDeals";
    if (/Best (game )?deals/i.test(text)) return "bestDeals";
    if (/Historical lows/i.test(text)) return "stop";
    if (/Popular wishlisted/i.test(text)) return "stop";
    return "";
  };
  const precedingKind = (node) => {
    let kind = "";
    for (const h of headings) {
      const k = kindOf(h.text);
      if (!k) continue;
      if (h.el === node || h.el.contains(node)) return k === "stop" ? "" : k;
      const pos = h.el.compareDocumentPosition(node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) kind = k;
    }
    return kind === "stop" ? "" : kind;
  };
  const seen = new Set();
  const games = [];
  const popular = [];
  const newDeals = [];
  const bestDeals = [];
  for (const a of document.querySelectorAll('a[href*="/game/"], a[href*="/steam/app/"]')) {
    const href = a.href || a.getAttribute("href") || "";
    const slug = (href.match(/\\/game\\/([^/?#]+)/) || [])[1] || "";
    const appId = (href.match(/\\/steam\\/app\\/(\\d+)/) || [])[1] || "";
    const key = slug || (appId ? "app-" + appId : "");
    if (!key || seen.has(key) || /^(deals|new-deals|best-deals|games|news|login)$/i.test(slug)) continue;
    seen.add(key);
    const img = a.querySelector("img") || (a.parentElement && a.parentElement.querySelector("img"));
    let name = (img && img.alt) || a.getAttribute("title") || a.getAttribute("aria-label") || "";
    name = String(name).replace(/^Go to:\\s*/i, "").replace(/\\s+PC$/i, "").trim();
    if (!name) name = slug.replace(/-/g, " ");
    const card = a.closest("article, li, [class*='game'], [class*='deal']") || a.parentElement;
    const row = {
      slug,
      appId,
      name,
      img: (img && (img.currentSrc || img.src || img.getAttribute("data-src"))) || "",
      text: ((card && card.innerText) || "").slice(0, 500),
    };
    games.push(row);
    const kind = precedingKind(a);
    if (kind === "popular") popular.push(row);
    else if (kind === "newDeals") newDeals.push(row);
    else if (kind === "bestDeals") bestDeals.push(row);
  }
  return {
    blocked,
    title: document.title || "",
    gameCount: games.length,
    popular,
    newDeals,
    bestDeals,
    games,
    html: document.documentElement.outerHTML,
  };
})()`;

function slimRows(list) {
  return (list || [])
    .filter((g) => g && (g.name || g.slug))
    .slice(0, 20)
    .map((g) => ({
      name: g.name || "",
      slug: g.slug || "",
      appId: g.appId || "",
      img: g.img || "",
      text: String(g.text || "").slice(0, 400),
    }));
}

function dumpSection(title, list) {
  const rows = slimRows(list);
  if (!rows.length) return "";
  let out = `\n## ${title}\n`;
  rows.forEach((g, i) => {
    const name = String(g.name || g.slug || "").trim();
    const href = g.slug
      ? `https://gg.deals/game/${g.slug}/`
      : g.appId
        ? `https://gg.deals/steam/app/${g.appId}/`
        : "#";
    out += `#${i + 1}\nGo to: ${name}\n${g.text || ""}\n`;
    if (g.img) out += `<img alt="${name}" src="${g.img}">\n`;
    out += `<a href="${href}">${name}</a>\n`;
  });
  return out;
}

function withParserDump(html, payload, url) {
  const path = String(url || "");
  let popular = payload.popular;
  let newDeals = payload.newDeals;
  let bestDeals = payload.bestDeals;
  if ((!popular || !popular.length) && payload.games?.length && !/new-deals|best-deals/i.test(path)) {
    popular = payload.games;
  }
  if ((!newDeals || !newDeals.length) && /new-deals/i.test(path)) newDeals = payload.games;
  if ((!bestDeals || !bestDeals.length) && /best-deals/i.test(path)) bestDeals = payload.games;
  const blob = {
    popular: slimRows(popular),
    newDeals: slimRows(newDeals),
    bestDeals: slimRows(bestDeals),
  };
  let dump = `___GGEXTRACT___\n${JSON.stringify(blob)}\n___/GGEXTRACT___\n`;
  dump += dumpSection("Most Popular Games", blob.popular);
  dump += dumpSection("New deals", blob.newDeals);
  dump += dumpSection("Best deals", blob.bestDeals);
  return dump + String(html || "");
}

function extractReady(payload, url) {
  if (!payload || payload.blocked) return false;
  const n = Number(payload.gameCount) || 0;
  const popular = payload.popular?.length || 0;
  const deals = (payload.newDeals?.length || 0) + (payload.bestDeals?.length || 0);
  if (/new-deals|best-deals/i.test(String(url || ""))) return n >= 5;
  return popular >= 5 || (deals >= 6 && n >= 10) || n >= 18;
}

async function readPayload(win) {
  try {
    return await win.webContents.executeJavaScript(EXTRACT_JS, true);
  } catch {
    return null;
  }
}

async function nudgeScroll(win) {
  try {
    await win.webContents.executeJavaScript(
      "window.scrollTo(0, 500); window.scrollTo(0, 1400); window.scrollTo(0, 0); true",
      true
    );
  } catch {
    // ignore
  }
}

async function fetchHtmlUnlocked(url, { timeoutMs = 70000 } = {}) {
  const win = await getScrapeWin();
  try {
    const deadline = Date.now() + Math.max(20000, Number(timeoutMs) || 70000);
    await Promise.race([
      win.loadURL(String(url), { userAgent: UA }),
      sleep(Math.max(15000, timeoutMs - 25000)).then(() => {
        throw new Error(`timeout ${url}`);
      }),
    ]);

    let payload = null;
    let i = 0;
    let focused = false;
    while (Date.now() < deadline) {
      payload = await readPayload(win);
      if (extractReady(payload, url)) {
        return withParserDump(payload.html || "", payload, url);
      }
      if (payload?.blocked && !focused && i >= 3) {
        focused = true;
        wakeScrapeWin(win, true);
        try {
          win.focus();
        } catch {
          // ignore
        }
      }
      if (i === 2 || i === 8 || i === 16) await nudgeScroll(win);
      i += 1;
      await sleep(payload?.blocked ? 1200 : 700);
    }
    const html = payload?.html || "";
    const title = payload?.title || "";
    if (payload && !payload.blocked && (payload.gameCount || 0) >= 5) {
      return withParserDump(html, payload, url);
    }
    if (looksBlocked(html, title) || html.length < 2000) {
      throw new Error("Cloudflare");
    }
    return html;
  } finally {
    restScrapeWin(win);
  }
}

async function fetchHtml(url, opts) {
  let release;
  const prev = scrapeLock;
  scrapeLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fetchHtmlUnlocked(url, opts);
  } finally {
    release();
  }
}

module.exports = { fetchHtml };
