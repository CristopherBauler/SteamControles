/**
 * Most Popular Games do gg.deals.
 * O site usa Cloudflare: tentamos baixar a página; se bloquear,
 * reaproveita o último ranking e só atualiza preço/capa pela Steam.
 */

const { searchSteamStore, mapPool, fetchAppDetails, capsuleUrl, isRateLimitError } = require("./steamApi");

const BOOTSTRAP = [
  "STAR WARS Zero Company",
  "The Witcher 3: Wild Hunt",
  "1666: Amsterdam",
  "Crimson Desert Enhanced",
  "METAL GEAR SOLID: MASTER COLLECTION Vol.2",
  "The Blood of Dawnwalker",
  "ELDEN RING",
  "How to Fish",
  "Cyberpunk 2077",
  "NBA 2K27 Deluxe Edition",
  "Red Dead Redemption 2",
  "Resonance: A Plague Tale Legacy",
  "Aliens: Fireteam Elite 2",
  "Grand Theft Auto V",
  "Terminator: Resistance",
  "The Witcher 3: Wild Hunt - Complete Edition",
  "Black Myth: Wukong",
  "Mortal Shell II",
  "Onimusha: Way of the Sword",
  "Baldur's Gate 3",
];

const BOOTSTRAP_IDS = {
  "star wars zero company": 2075800,
  "the witcher 3 wild hunt": 292030,
  "1666 amsterdam": 3949550,
  "crimson desert enhanced": 3321460,
  "metal gear solid master collection vol 2": 3859630,
  "the blood of dawnwalker": 3751260,
  "elden ring": 1245620,
  "how to fish": 4001890,
  "cyberpunk 2077": 1091500,
  "red dead redemption 2": 1174180,
  "resonance a plague tale legacy": 2713000,
  "aliens fireteam elite 2": 3448650,
  "grand theft auto v": 271590,
  "terminator resistance": 954740,
  "the witcher 3 wild hunt complete edition": 292030,
  "black myth wukong": 2358720,
  "mortal shell ii": 2584270,
  "onimusha way of the sword": 2638890,
  "baldur s gate 3": 1086940,
};

function popularCover(appId, extra = {}) {
  const id = Number(appId);
  return (
    extra.headerImage ||
    extra.image ||
    extra.tinyImage ||
    (Number.isInteger(id) && id > 0 ? capsuleUrl(id) : "")
  );
}

function seedDeal({ name, discount, currentPrice, store, historicalLow, slug, appId, free }) {
  const image = appId
    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`
    : "";
  return {
    name,
    discount: discount || 0,
    currentPrice: free ? 0 : currentPrice,
    currency: free ? null : "BRL",
    usdPrice: null,
    priceLabel: free ? "Free" : null,
    store: store || "Steam",
    relativeTime: "",
    historicalLow: Boolean(historicalLow),
    appId: appId || null,
    image,
    headerImage: image,
    ggDealsUrl: `https://gg.deals/game/${slug}/`,
    source: store || "Steam",
  };
}

/** Snapshot da home do gg.deals (print do usuário). Nunca preencher com Steam specials. */
const SEED_DEALS = {
  newDeals: [
    seedDeal({ name: "BZZZT", discount: 75, currentPrice: 4.99, slug: "bzzzt", appId: 1293170 }),
    seedDeal({ name: "The Planet Crafter", discount: 50, currentPrice: 36.99, slug: "the-planet-crafter", appId: 1284190 }),
    seedDeal({ name: "Enshrouded", discount: 25, currentPrice: 67.49, historicalLow: true, slug: "enshrouded", appId: 1203620 }),
    seedDeal({ name: "ASTRONEER", discount: 75, currentPrice: 22.24, slug: "astroneer", appId: 361420 }),
    seedDeal({ name: "The Quinfall", discount: 90, currentPrice: 4.49, historicalLow: true, slug: "the-quinfall", appId: 2294660 }),
    seedDeal({ name: "The Forest", discount: 78, currentPrice: 8.35, slug: "the-forest", appId: 242760 }),
    seedDeal({ name: "Mirthwood", discount: 30, currentPrice: 51.79, historicalLow: true, slug: "mirthwood", appId: 2272900 }),
    seedDeal({ name: "Omega Crafter", discount: 40, currentPrice: 44.39, historicalLow: true, slug: "omega-crafter", appId: 2262080 }),
    seedDeal({
      name: "Grand Emprise: Time Travel Survival",
      discount: 50,
      currentPrice: 29.99,
      slug: "grand-emprise-time-travel-survival",
      appId: 2236300,
    }),
    seedDeal({ name: "My Dream Setup", discount: 60, currentPrice: 8.19, historicalLow: true, slug: "my-dream-setup", appId: 2200780 }),
  ],
  bestDeals: [
    seedDeal({
      name: "Rival Stars Horse Racing Desktop",
      free: true,
      historicalLow: true,
      store: "Epic Games Store",
      slug: "rival-stars-horse-racing-desktop",
      appId: 1166860,
    }),
    seedDeal({
      name: "Breathedge",
      free: true,
      historicalLow: true,
      store: "Epic Games Store",
      slug: "breathedge",
      appId: 738520,
    }),
    seedDeal({
      name: "Echoes of the End Enhanced",
      discount: 80,
      currentPrice: 39.78,
      store: "Difmark",
      slug: "echoes-of-the-end-enhanced",
      appId: 2821610,
    }),
    seedDeal({ name: "Loco Motive", discount: 55, currentPrice: 22.49, historicalLow: true, slug: "loco-motive", appId: 1709880 }),
    seedDeal({
      name: "Cyberpunk 2077",
      discount: 70,
      currentPrice: 59.95,
      historicalLow: true,
      store: "GOG",
      slug: "cyberpunk-2077",
      appId: 1091500,
    }),
    seedDeal({
      name: "Resident Evil 4",
      discount: 80,
      currentPrice: 32.99,
      historicalLow: true,
      store: "Nuuvem",
      slug: "resident-evil-4",
      appId: 2050650,
    }),
    seedDeal({
      name: "Kingdom Come Deliverance II",
      discount: 77,
      currentPrice: 65.96,
      store: "GameBoost",
      slug: "kingdom-come-deliverance-ii",
      appId: 1771300,
    }),
    seedDeal({ name: "Sons Of The Forest", discount: 70, currentPrice: 26.69, slug: "sons-of-the-forest", appId: 1326470 }),
    seedDeal({
      name: "Crimson Desert Enhanced",
      discount: 61,
      currentPrice: 136.49,
      store: "GameBoost",
      slug: "crimson-desert-enhanced",
      appId: 3321460,
    }),
    seedDeal({
      name: "Pentiment",
      discount: 82,
      currentPrice: 16.86,
      historicalLow: true,
      store: "G2Play",
      slug: "pentiment",
      appId: 1205520,
    }),
  ],
};

function nonemptyDeals(list) {
  return Array.isArray(list) && list.length > 0 ? list : null;
}

function resolveDealLists(incoming = {}, previous = {}) {
  return {
    newDeals: nonemptyDeals(incoming.newDeals) || nonemptyDeals(previous.newDeals) || [],
    bestDeals: nonemptyDeals(incoming.bestDeals) || nonemptyDeals(previous.bestDeals) || [],
  };
}

const GG_URLS = [
  "https://gg.deals/?region=br",
  "https://gg.deals/",
  "https://gg.deals/games/?sort=popularity&region=br",
];

/** Chromium do Electron, se o app estiver rodando. Node fetch sozinho leva Cloudflare. */
let htmlFetcher = null;

function setHtmlFetcher(fn) {
  htmlFetcher = typeof fn === "function" ? fn : null;
}

const GG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

async function fetchText(url) {
  if (htmlFetcher) {
    const text = await htmlFetcher(url, { timeoutMs: 70000 });
    if (/just a moment|cf-browser-verification|challenge-platform/i.test(text) && !/___GGEXTRACT___/.test(text)) {
      throw new Error("Cloudflare");
    }
    return text;
  }
  const response = await fetch(url, {
    headers: GG_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (/just a moment|cf-browser-verification|challenge-platform/i.test(text)) {
    throw new Error("Cloudflare");
  }
  return text;
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

function parseUsd(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseExtractBlob(text) {
  const match = String(text || "").match(/___GGEXTRACT___\n([\s\S]*?)\n___\/GGEXTRACT___/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function dealsFromExtractRows(rows) {
  const games = [];
  const seen = new Set();
  for (const row of rows || []) {
    const name = decodeHtml(row?.name || "")
      .replace(/\s+PC$/i, "")
      .trim();
    if (!isDealName(name)) continue;
    const key = String(row.slug || name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    games.push(
      dealFromParts(name, row.text || "", {
        slug: row.slug,
        appId: row.appId,
        image: row.img,
      })
    );
    if (games.length >= 12) break;
  }
  return games;
}

function popularFromExtractRows(rows) {
  return dealsFromExtractRows(rows).map((game, i) => ({
    rank: i + 1,
    name: game.name,
    discount: game.discount,
    usdPrice: game.usdPrice,
    currentPrice: game.currentPrice,
    ggDealsUrl: game.ggDealsUrl,
    appId: game.appId,
    image: game.image,
    source: "gg.deals",
  }));
}

function isolateMdSection(text, heading, nextHeadings = []) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = String(text || "").search(new RegExp(`(?:^|\\n)##\\s*${escaped}\\b`, "i"));
  if (start < 0) return "";
  let chunk = text.slice(start);
  if (!nextHeadings.length) return chunk;
  const next = nextHeadings
    .map((h) => String(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((h) => `(?:\\n##\\s*)${h}\\b`)
    .join("|");
  const cut = chunk.slice(8).search(new RegExp(next, "i"));
  if (cut >= 0) chunk = chunk.slice(0, 8 + cut);
  return chunk;
}

function isolateSection(text, heading, nextHeadings = []) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const slug = escaped.replace(/\\s\+/g, "[-\\s]+").replace(/\s+/g, "[-\\s]+");
  const headingRe = new RegExp(
    `(?:##\\s*|<h[1-4][^>]*>|>)${escaped}\\b|See all ${escaped}|id="[^"]*${slug}[^"]*"`,
    "i"
  );
  const start = text.search(headingRe);
  if (start < 0) return "";
  let chunk = text.slice(start);
  if (!nextHeadings.length) return chunk;
  const next = nextHeadings
    .map((h) => String(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((h) => `(?:\\n##\\s*|<h[1-4][^>]*>|>)${h}\\b`)
    .join("|");
  const cut = chunk.slice(48).search(new RegExp(next, "i"));
  if (cut >= 0) chunk = chunk.slice(0, 48 + cut);
  return chunk;
}

const STORE_PATTERNS = [
  ["Epic Games Store", /epic games store|shop-icon-epic|\bepic\b/i],
  ["Nuuvem", /nuuvem/i],
  ["GOG", /\bgog\b|shop-icon-gog/i],
  ["Fanatical", /fanatical/i],
  ["Humble Store", /humble/i],
  ["Green Man Gaming", /green man gaming|\bgmg\b|greenmangaming/i],
  ["Microsoft Store", /microsoft store|\bxbox\b/i],
  ["PlayStation Store", /playstation|shop-icon-playstation/i],
  ["Nintendo eShop", /nintendo|e-?shop/i],
  ["Amazon", /\bamazon\b/i],
  ["Steam", /\bsteam\b|shop-icon-steam/i],
];

function storeFromShopSlug(slug) {
  const s = String(slug || "")
    .toLowerCase()
    .replace(/_/g, "-");
  const map = {
    steam: "Steam",
    epic: "Epic Games Store",
    "epic-games": "Epic Games Store",
    "epic-games-store": "Epic Games Store",
    egs: "Epic Games Store",
    nuuvem: "Nuuvem",
    gog: "GOG",
    fanatical: "Fanatical",
    humble: "Humble Store",
    "humble-store": "Humble Store",
    greenmangaming: "Green Man Gaming",
    "green-man-gaming": "Green Man Gaming",
    microsoft: "Microsoft Store",
    xbox: "Microsoft Store",
    playstation: "PlayStation Store",
    nintendo: "Nintendo eShop",
    amazon: "Amazon",
  };
  return map[s] || null;
}

function parseStore(text) {
  const blob = String(text || "");
  const shopClass = blob.match(/shop-icon-([a-z0-9-]+)/i)?.[1];
  const fromClass = storeFromShopSlug(shopClass);
  if (fromClass) return fromClass;
  const titled = blob.match(
    /(?:title|alt)="(Steam|Epic Games Store|Nuuvem|GOG|Fanatical|Humble Store|Green Man Gaming|Microsoft Store|PlayStation Store|Nintendo eShop|Amazon)[^"]*"/i
  );
  if (titled) return titled[1];
  for (const [name, re] of STORE_PATTERNS) {
    if (re.test(blob)) return name;
  }
  return "Steam";
}

function parseRelativeTime(text) {
  const m = String(text || "").match(
    /(\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|mins?|hrs?|secs?)\s+ago|\d+\s*[smhd]\s*ago|just now|yesterday|há\s+\d+\s+[^\n<,]+)/i
  );
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function parseDealPrice(text) {
  const blob = String(text || "");
  if (/Current price:\s*Free\b/i.test(blob) || /game-price-new[^>]*>\s*Free/i.test(blob)) {
    return { currentPrice: 0, currency: null, usdPrice: null, priceLabel: "Free" };
  }
  const brl =
    blob.match(/Current price:\s*R\$\s*([\d.]+),(\d{2})/i) || blob.match(/R\$\s*([\d.]+),(\d{2})/);
  if (brl) {
    const n = Number(`${String(brl[1]).replace(/\./g, "")}.${brl[2]}`);
    if (Number.isFinite(n)) {
      return { currentPrice: n, currency: "BRL", usdPrice: null, priceLabel: null };
    }
  }
  const usd = blob.match(/Current price:\s*\$([\d,.]+)/i) || blob.match(/game-price-new[^>]*>\s*\$([\d,.]+)/i);
  if (usd) {
    const n = parseUsd(usd[1]);
    return {
      currentPrice: n,
      currency: n != null ? "USD" : null,
      usdPrice: n,
      priceLabel: n != null ? `US$ ${n.toFixed(2)}` : null,
    };
  }
  if (/\bFree\b/i.test(blob) && /-\s*100\s*%/.test(blob)) {
    return { currentPrice: 0, currency: null, usdPrice: null, priceLabel: "Free" };
  }
  return { currentPrice: null, currency: null, usdPrice: null, priceLabel: null };
}

function isDealName(name) {
  const n = String(name || "").trim();
  if (n.length < 2 || n.length > 120) return false;
  if (
    /^(see all|go to|discount|historical low|current price|new deals|best deals|more deals|sign in|games on sale)/i.test(
      n
    )
  ) {
    return false;
  }
  if (/^https?:/i.test(n)) return false;
  return true;
}

function dealFromParts(name, body, extra = {}) {
  const blob = `${body || ""} ${extra.html || ""}`;
  const discount = Number(
    blob.match(/Discount:\s*-(\d+)\s*%/i)?.[1] || blob.match(/-(\d+)\s*%/)?.[1] || extra.discount || 0
  );
  const price = parseDealPrice(blob);
  const slug = extra.slug || blob.match(/gg\.deals\/game\/([^/"'\s]+)/i)?.[1] || slugify(name);
  const appIdRaw = Number(
    extra.appId || blob.match(/steam\/app\/(\d+)/i)?.[1] || blob.match(/data-(?:steam-)?app-id="(\d+)"/i)?.[1]
  );
  const appId = Number.isInteger(appIdRaw) && appIdRaw > 0 ? appIdRaw : null;
  const image = extra.image || "";
  const ggDealsUrl = extra.ggDealsUrl || (slug ? `https://gg.deals/game/${slug}/` : appId ? `https://gg.deals/steam/app/${appId}/` : "");
  const store = extra.store || parseStore(blob);
  return {
    name,
    discount,
    historicalLow: /historical low/i.test(blob) || Boolean(extra.historicalLow),
    ...price,
    store,
    relativeTime: extra.relativeTime || parseRelativeTime(blob),
    appId,
    image,
    headerImage: image,
    ggDealsUrl,
    source: store || "gg.deals",
  };
}

function parseDealsFromText(chunk) {
  const games = [];
  const seen = new Set();
  const re = /Go to:\s*([^\n<]+)/gi;
  let match;
  let lastIndex = 0;
  while ((match = re.exec(chunk)) && games.length < 12) {
    const name = decodeHtml(match[1]).trim();
    const body = chunk.slice(lastIndex, match.index + match[0].length);
    lastIndex = match.index + match[0].length;
    if (!isDealName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    games.push(dealFromParts(name, body));
  }
  return games;
}

function parseDealsFromHtml(chunk) {
  const games = [];
  const seen = new Set();
  const re = /href=["'](?:https:\/\/gg\.deals)?\/(?:game\/([^"'/?#]+)|steam\/app\/(\d+))/gi;
  let match;
  while ((match = re.exec(chunk)) && games.length < 12) {
    const slug = match[1] || "";
    const steamId = match[2] || "";
    const key = slug || `app-${steamId}`;
    if (!key || seen.has(key) || /^(deals|new-deals|best-deals|games|news|login)$/i.test(slug)) continue;
    seen.add(key);
    const window = chunk.slice(Math.max(0, match.index - 200), match.index + 1800);
    const name = decodeHtml(
      window.match(/alt="([^"]+)"/)?.[1] ||
        window.match(/title="([^"]+)"/)?.[1] ||
        window.match(/Go to:\s*([^<"\n]+)/i)?.[1] ||
        slug.replace(/-/g, " ")
    );
    if (!isDealName(name)) continue;
    const img =
      window.match(/src="(https:\/\/img\.gg\.deals\/[^"]+)"/i)?.[1] ||
      window.match(/src="(https:\/\/[^"]+game[^"]+\.(?:jpg|png|webp)[^"]*)"/i)?.[1] ||
      "";
    games.push(
      dealFromParts(name, window, {
        slug,
        appId: steamId,
        image: img,
        ggDealsUrl: slug
          ? `https://gg.deals/game/${slug}/`
          : steamId
            ? `https://gg.deals/steam/app/${steamId}/`
            : "",
      })
    );
  }
  return games;
}

function parseDealSection(text, heading, nextHeadings) {
  const md = isolateMdSection(text, heading, nextHeadings);
  if (md) {
    const fromMd = parseDealsFromText(md);
    if (fromMd.length >= 5) return fromMd.slice(0, 10);
    const htmlInMd = /href=|<a\s/i.test(md) ? parseDealsFromHtml(md) : [];
    if (htmlInMd.length >= 5) return htmlInMd.slice(0, 10);
    if (fromMd.length) return fromMd.slice(0, 10);
  }
  const chunk = isolateSection(text, heading, nextHeadings);
  if (!chunk) return [];
  const fromHtml = /href=|<a\s/i.test(chunk) ? parseDealsFromHtml(chunk) : [];
  const fromText = parseDealsFromText(chunk);
  if (fromText.length >= 5) return fromText.slice(0, 10);
  if (fromHtml.length >= 5) return fromHtml.slice(0, 10);
  if (fromText.length) return fromText.slice(0, 10);
  return fromHtml.slice(0, 10);
}

function parseDealListPage(text) {
  for (const heading of ["New deals", "New game deals", "Best deals", "Best game deals"]) {
    const section = parseDealSection(text, heading, [
      "Best deals",
      "Best game deals",
      "Historical lows",
      "Most Popular",
    ]);
    if (section.length >= 5) return section;
  }
  const html = parseDealsFromHtml(text);
  if (html.length) return html.slice(0, 10);
  return parseDealsFromText(text).slice(0, 10);
}

function parsePopular(text) {
  const md = isolateMdSection(text, "Most Popular Games", ["New deals", "Best deals"]);
  const fromMd = md ? parsePopularFromText(md) : [];
  if (fromMd.length >= 5) return fromMd;
  const fromText = parsePopularFromText(text);
  if (fromText.length >= 5) return fromText;
  const fromHtml = /<html/i.test(text) ? parsePopularFromHtml(text) : [];
  return fromHtml.length >= fromText.length ? fromHtml : fromText;
}

function isolatePopularChunk(text) {
  const start = text.search(/Most Popular Games/i);
  let chunk = start >= 0 ? text.slice(start) : text;
  const cut = chunk.search(/\n## New deals|\n## Popular wishlisted|<h2[^>]*>New deals/i);
  if (cut > 80) chunk = chunk.slice(0, cut);
  return chunk;
}

function parsePopularFromText(text) {
  const chunk = isolatePopularChunk(text);
  const parts = chunk.split(/#(\d{1,2})\b/);
  const games = [];
  const seen = new Set();

  for (let i = 1; i < parts.length; i += 2) {
    const rank = Number(parts[i]);
    const body = parts[i + 1] || "";
    const gos = [...body.matchAll(/Go to:\s*([^\n<]+)/gi)].map((m) => decodeHtml(m[1]));
    const heading = body.match(/^\s*([A-Z0-9][^\n]{1,90})\s*$/m);
    const name = (gos.find((g) => g && !/^discount/i.test(g)) || heading?.[1] || "").trim();
    if (!name || name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slug =
      body.match(/gg\.deals\/game\/([^/"'\s]+)/i)?.[1] ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    games.push({
      rank: Number.isInteger(rank) ? rank : games.length + 1,
      name,
      discount: Number(body.match(/Discount:\s*-(\d+)\s*%/i)?.[1] || 0),
      usdPrice: parseUsd(body.match(/Current price:\s*\$([\d,.]+)/i)?.[1]),
      ggDealsUrl: `https://gg.deals/game/${slug}/`,
      source: "gg.deals",
    });
    if (games.length >= 20) break;
  }
  return games;
}

function parsePopularFromHtml(html) {
  const chunk = isolatePopularChunk(html);
  const games = [];
  const seen = new Set();
  const re = /href=["'](?:https:\/\/gg\.deals)?\/game\/([^"'/?#]+)/gi;
  let match;
  while ((match = re.exec(chunk)) && games.length < 20) {
    const slug = match[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const window = chunk.slice(match.index, match.index + 1200);
    const name =
      decodeHtml(
        window.match(/alt="([^"]+)"/)?.[1] ||
          window.match(/title="([^"]+)"/)?.[1] ||
          slug.replace(/-/g, " ")
      );
    const img = window.match(/src="(https:\/\/[^"]+game[^"]+\.(?:jpg|png|webp)[^"]*)"/i)?.[1] || "";
    const discount = Number(window.match(/-(\d+)\s*%/)?.[1] || 0);
    games.push({
      rank: games.length + 1,
      name,
      discount,
      image: img,
      ggDealsUrl: `https://gg.deals/game/${slug}/`,
      source: "gg.deals",
    });
  }
  return games;
}

let homeInflight = null;

function beginGgScrapeSession() {
  homeInflight = null;
}

async function scrapeGgDealsHomeUncached() {
  let lastError;
  let popular = [];
  let newDeals = [];
  let bestDeals = [];
  let sourceUrl = "";

  for (const url of GG_URLS) {
    try {
      const text = await fetchText(url);
      sourceUrl = url;
      const extract = parseExtractBlob(text);
      if (extract) {
        popular = popularFromExtractRows(extract.popular);
        newDeals = dealsFromExtractRows(extract.newDeals);
        bestDeals = dealsFromExtractRows(extract.bestDeals);
      }
      if (!popular.length) popular = parsePopular(text);
      if (!newDeals.length) {
        newDeals = parseDealSection(text, "New deals", ["Best deals", "Historical lows"]);
      }
      if (!newDeals.length) {
        newDeals = parseDealSection(text, "New game deals", ["Best deals", "Best game deals", "Historical lows"]);
      }
      if (!bestDeals.length) {
        bestDeals = parseDealSection(text, "Best deals", ["Historical lows", "Popular wishlisted"]);
      }
      if (!bestDeals.length) {
        bestDeals = parseDealSection(text, "Best game deals", ["Historical lows", "Popular wishlisted"]);
      }
      if (popular.length || newDeals.length || bestDeals.length) break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!popular.length && !newDeals.length && !bestDeals.length) {
    throw lastError || new Error("gg.deals indisponível");
  }

  if (!newDeals.length) {
    try {
      newDeals = parseDealListPage(await fetchText("https://gg.deals/deals/new-deals/?region=br"));
    } catch {
      /* homepage already tried */
    }
  }
  if (!bestDeals.length) {
    try {
      bestDeals = parseDealListPage(await fetchText("https://gg.deals/deals/best-deals/?region=br"));
    } catch {
      /* homepage already tried */
    }
  }

  return { popular, newDeals, bestDeals, sourceUrl };
}

function scrapeGgDealsHome() {
  if (!homeInflight) {
    const pending = scrapeGgDealsHomeUncached();
    homeInflight = pending;
    pending.finally(() => {
      setTimeout(() => {
        if (homeInflight === pending) homeInflight = null;
      }, 8000);
    });
  }
  return homeInflight;
}

async function scrapeGgDeals() {
  const home = await scrapeGgDealsHome();
  return { games: home.popular || [], sourceUrl: home.sourceUrl };
}

function namesMatch(a, b) {
  const norm = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/™|®/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const tokens = right.split(" ").filter((w) => w.length > 2);
  if (!tokens.length) return false;
  const hits = tokens.filter((w) => left.includes(w)).length;
  return hits >= Math.min(2, tokens.length);
}

async function enrichWithSteam(games, { country, language, ownedIds, previous = [] } = {}) {
  const owned = ownedIds instanceof Set ? ownedIds : new Set();
  const prevByName = new Map((previous || []).filter((g) => g?.name).map((g) => [normName(g.name), g]));
  const extras = await mapPool(games, 5, async (game) => {
    const cached = prevByName.get(normName(game.name));
    let appId =
      Number(game.appId) ||
      Number(cached?.appId) ||
      BOOTSTRAP_IDS[normName(game.name)] ||
      null;
    let searchHit = null;
    if (!Number.isInteger(appId) || appId <= 0) {
      try {
        const found = await searchSteamStore(game.name, { country, language, timeoutMs: 4000 });
        if (found?.appId && (namesMatch(game.name, found.steamName) || !cached)) {
          appId = found.appId;
          searchHit = found;
        }
      } catch {
        appId = null;
      }
    }
    if (!Number.isInteger(appId) || appId <= 0) {
      return { details: null, appId: null, cached, searchHit };
    }
    try {
      const details = await fetchAppDetails(appId, { country, language, timeoutMs: 4000 });
      return { details, appId, cached, searchHit };
    } catch {
      return { details: null, appId, cached, searchHit };
    }
  });

  return games.map((game, i) => {
    const pack = extras[i] || {};
    const cached = pack.cached || prevByName.get(normName(game.name));
    const details = pack.details || null;
    const appId = Number(details?.appId || pack.appId || game.appId || cached?.appId) || null;
    const hasId = Number.isInteger(appId) && appId > 0;
    const image = popularCover(hasId ? appId : null, {
      headerImage: details?.headerImage || cached?.headerImage || game.headerImage,
      image: details?.capsuleImage || cached?.image || game.image,
      tinyImage: pack.searchHit?.tinyImage,
    });
    const price = details?.currentPrice ?? game.currentPrice ?? cached?.currentPrice ?? pack.searchHit?.currentPrice ?? null;
    const discount = Number(details?.discount || game.discount || cached?.discount || pack.searchHit?.discount || 0);
    return {
      rank: game.rank || i + 1,
      name: game.name,
      appId: hasId ? appId : null,
      owned: Boolean(hasId && owned.has(appId)),
      currentPrice: price,
      discount,
      image,
      headerImage: image,
      smallImage: image,
      storeUrl: details?.storeUrl || (hasId ? `https://store.steampowered.com/app/${appId}` : game.ggDealsUrl || "#"),
      ggDealsUrl:
        game.ggDealsUrl ||
        cached?.ggDealsUrl ||
        (hasId ? `https://gg.deals/steam/app/${appId}/` : `https://gg.deals/game/${slugify(game.name)}/`),
      source: "gg.deals",
      status: discount > 0 ? "queda" : "igual",
    };
  });
}

function rankRow(game, i, cached) {
  return {
    rank: i + 1,
    name: game.name,
    discount: game.discount || cached?.discount || 0,
    currentPrice: game.currentPrice ?? cached?.currentPrice,
    ggDealsUrl: game.ggDealsUrl || cached?.ggDealsUrl || `https://gg.deals/game/${slugify(game.name)}/`,
    appId: Number(game.appId) || Number(cached?.appId) || BOOTSTRAP_IDS[normName(game.name)] || null,
    image: game.image || game.headerImage || cached?.image || cached?.headerImage || "",
    headerImage: game.headerImage || game.image || cached?.headerImage || cached?.image || "",
    source: "gg.deals",
  };
}

function fillPopularRanking(primary, previous) {
  const prevByName = new Map((previous || []).filter((g) => g?.name).map((g) => [normName(g.name), g]));
  const scraped = (primary || []).filter((game) => game?.name);
  if (scraped.length >= 5) {
    return scraped.slice(0, 20).map((game, i) => rankRow(game, i, prevByName.get(normName(game.name))));
  }
  const leftover = [...(previous || [])]
    .filter((game) => game?.name)
    .sort((a, b) => Number(a.rank || 99) - Number(b.rank || 99));
  if (leftover.length) {
    return leftover.slice(0, 20).map((game, i) => rankRow(game, i, prevByName.get(normName(game.name))));
  }
  return BOOTSTRAP.slice(0, 20).map((name, i) =>
    rankRow({ name, appId: BOOTSTRAP_IDS[normName(name)] || null }, i, prevByName.get(normName(name)))
  );
}

async function fetchGgDealsPopular({ country, language, ownedIds, previous = [] } = {}) {
  beginGgScrapeSession();
  let scrapedList = [];
  let scraped = false;
  try {
    const result = await scrapeGgDeals();
    scrapedList = result.games || [];
    scraped = scrapedList.length > 0;
  } catch {
    scraped = false;
  }

  const ranking = fillPopularRanking(scrapedList, previous);
  let games = ranking.map((game, i) => ({
    rank: i + 1,
    name: game.name,
    appId: game.appId || null,
    owned: false,
    currentPrice: game.currentPrice ?? null,
    discount: game.discount || 0,
    image: game.headerImage || game.image || (game.appId ? popularCover(game.appId) : ""),
    headerImage: game.headerImage || game.image || (game.appId ? popularCover(game.appId) : ""),
    smallImage: game.headerImage || game.image || "",
    storeUrl: game.appId ? `https://store.steampowered.com/app/${game.appId}` : game.ggDealsUrl || "#",
    ggDealsUrl: game.ggDealsUrl,
    source: "gg.deals",
    status: Number(game.discount) > 0 ? "queda" : "igual",
  }));
  try {
    games = await enrichWithSteam(ranking, {
      country,
      language,
      ownedIds: ownedIds || new Set(),
      previous,
    });
  } catch {
    /* ranking sem preço Steam ainda aparece no painel */
  }
  return { games: games.slice(0, 20), scraped };
}

function normName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/™|®/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function indexAppIds(lists) {
  const map = new Map();
  for (const list of lists || []) {
    for (const game of list || []) {
      const key = normName(game?.name);
      const appId = Number(game?.appId);
      if (key && Number.isInteger(appId) && appId > 0 && !map.has(key)) map.set(key, appId);
    }
  }
  return map;
}

function isGgDealsCdn(url) {
  return /img\.gg\.deals/i.test(String(url || ""));
}

function dealSteamCover(appId) {
  const id = Number(appId);
  return Number.isInteger(id) && id > 0 ? capsuleUrl(id) : "";
}

function searchAliases(name) {
  const base = String(name || "")
    .replace(/\s+PC$/i, "")
    .trim();
  const aliases = [base];
  if (base.includes("|")) aliases.push(base.split("|")[0].trim());
  return [...new Set(aliases.filter((item) => item.length >= 2))];
}

async function enrichDeals(games, { country, language, ownedIds, previous = [], knownGames = [] } = {}) {
  const owned = ownedIds instanceof Set ? ownedIds : new Set();
  const known = indexAppIds([previous, knownGames]);
  const prepared = (games || []).map((game) => {
    const cached = (previous || []).find((p) => normName(p.name) === normName(game.name));
    const appId = Number(game.appId) || known.get(normName(game.name)) || Number(cached?.appId) || null;
    const steam = dealSteamCover(appId);
    const raw = game.image || cached?.image || cached?.headerImage || "";
    const image = steam || (isGgDealsCdn(raw) ? "" : raw);
    return {
      ...game,
      appId: Number.isInteger(appId) && appId > 0 ? appId : null,
      image,
      headerImage: image,
      ggDealsUrl:
        game.ggDealsUrl ||
        cached?.ggDealsUrl ||
        (appId ? `https://gg.deals/steam/app/${appId}/` : `https://gg.deals/game/${slugify(game.name)}/`),
    };
  });

  let rateLimited = false;
  const missing = prepared
    .map((game, index) => ({ game, index }))
    .filter(({ game }) => !game.appId);
  const found = await mapPool(missing, 4, async ({ game }) => {
    if (rateLimited) return null;
    try {
      for (const query of searchAliases(game.name)) {
        const hit = await searchSteamStore(query, { country, language, timeoutMs: 4000 });
        if (hit?.appId && (namesMatch(game.name, hit.steamName) || namesMatch(query, hit.steamName))) {
          return hit;
        }
      }
    } catch (error) {
      if (isRateLimitError(error)) rateLimited = true;
    }
    return null;
  });

  for (let i = 0; i < missing.length; i += 1) {
    const hit = found[i];
    if (!hit?.appId) continue;
    const game = prepared[missing[i].index];
    game.appId = hit.appId;
    game.image = capsuleUrl(hit.appId) || hit.tinyImage || "";
    game.headerImage = game.image;
    if (isSteamStore(game.store) && game.currentPrice !== 0 && hit.currentPrice != null) {
      game.currentPrice = hit.currentPrice;
      game.currency = "BRL";
      game.priceLabel = null;
    }
    if (!game.ggDealsUrl || /\/game\//.test(game.ggDealsUrl) === false) {
      game.ggDealsUrl = `https://gg.deals/steam/app/${hit.appId}/`;
    }
  }

  return prepared.map((game) => {
    const steam = dealSteamCover(game.appId);
    const image = steam || (isGgDealsCdn(game.image) ? "" : game.image) || "";
    return {
      ...game,
      image,
      headerImage: steam || (isGgDealsCdn(game.headerImage) ? "" : game.headerImage) || image,
      owned: Boolean(game.appId && owned.has(game.appId)),
      source: game.store || game.source || "gg.deals",
      ggDealsUrl:
        game.ggDealsUrl ||
        (game.appId ? `https://gg.deals/steam/app/${game.appId}/` : `https://gg.deals/game/${slugify(game.name)}/`),
    };
  });
}

function usdOnlyDeals(lists) {
  const all = lists.flat();
  if (!all.length) return false;
  return all.some((g) => g.currency === "USD" && g.currentPrice !== 0);
}

function cacheDeals(list) {
  return (list || [])
    .filter((game) => game?.name)
    .map((game) => ({
      name: game.name,
      discount: game.discount || 0,
      currentPrice: game.currentPrice,
      currency: game.currency || null,
      usdPrice: game.usdPrice,
      priceLabel: game.priceLabel || null,
      store: game.store || "gg.deals",
      relativeTime: game.relativeTime || "",
      historicalLow: Boolean(game.historicalLow),
      appId: game.appId || null,
      image: game.image || game.headerImage || "",
      headerImage: game.headerImage || game.image || "",
      ggDealsUrl: game.ggDealsUrl,
      source: game.store || game.source || "gg.deals",
    }));
}

async function fetchGgDealsDeals({
  country,
  language,
  ownedIds,
  previous = {},
  knownGames = [],
} = {}) {
  const prevNew = cacheDeals(previous.newDeals);
  const prevBest = cacheDeals(previous.bestDeals);
  let newDeals = [];
  let bestDeals = [];
  let scrapedNew = false;
  let scrapedBest = false;

  try {
    const home = await scrapeGgDealsHome();
    if (home.newDeals?.length) {
      newDeals = home.newDeals;
      scrapedNew = true;
    } else {
      newDeals = prevNew;
    }
    if (home.bestDeals?.length) {
      bestDeals = home.bestDeals;
      scrapedBest = true;
    } else {
      bestDeals = prevBest;
    }
  } catch {
    newDeals = prevNew;
    bestDeals = prevBest;
  }

  const opts = {
    country,
    language,
    ownedIds: ownedIds || new Set(),
    knownGames,
  };
  const fromCache = (list) =>
    (list || []).map((game) => {
      const steam = dealSteamCover(game.appId);
      const image = steam || (isGgDealsCdn(game.image) ? "" : game.image) || (isGgDealsCdn(game.headerImage) ? "" : game.headerImage) || "";
      return {
        ...game,
        owned: Boolean(game.appId && ownedIds?.has(game.appId)),
        image,
        headerImage: image,
      };
    });

  newDeals = scrapedNew
    ? await enrichDeals(newDeals, { ...opts, previous: prevNew })
    : fromCache(newDeals);
  bestDeals = scrapedBest
    ? await enrichDeals(bestDeals, { ...opts, previous: prevBest })
    : fromCache(bestDeals);

  const resolved = resolveDealLists({ newDeals, bestDeals }, previous);
  newDeals = resolved.newDeals;
  bestDeals = resolved.bestDeals;
  const scraped = scrapedNew || scrapedBest;

  return {
    newDeals,
    bestDeals,
    scraped,
    usdOnly: usdOnlyDeals([newDeals, bestDeals]),
  };
}

module.exports = {
  fetchGgDealsPopular,
  fetchGgDealsDeals,
  resolveDealLists,
  setHtmlFetcher,
  beginGgScrapeSession,
  SEED_DEALS,
  parsePopularFromText,
  parsePopularFromHtml,
  parseDealsFromText,
  parseDealsFromHtml,
  parseDealSection,
};
