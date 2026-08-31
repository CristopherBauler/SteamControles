/**
 * Most Popular Games do gg.deals.
 * O site usa Cloudflare: tentamos baixar a página; se bloquear,
 * reaproveita o último ranking e só atualiza preço/capa pela Steam.
 */

const { searchSteamStore, mapPool, fetchAppDetails } = require("./steamApi");

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

const GG_URLS = [
  "https://gg.deals/",
  "https://gg.deals/games/?sort=popularity",
];

const GG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

async function fetchText(url) {
  const response = await fetch(url, {
    headers: GG_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(4000),
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
  const re = /href="(?:https:\/\/gg\.deals)?\/game\/([^"/]+)\/*"/gi;
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

async function scrapeGgDeals() {
  let lastError;
  for (const url of GG_URLS) {
    try {
      const text = await fetchText(url);
      const fromHtml = /<html/i.test(text) ? parsePopularFromHtml(text) : [];
      const fromText = parsePopularFromText(text);
      const games = fromHtml.length >= 10 ? fromHtml : fromText;
      if (games.length) return { games, sourceUrl: url };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("gg.deals indisponível");
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

async function enrichWithSteam(games, { country, language, ownedIds }) {
  const extras = await mapPool(games, 5, async (game) => {
    let appId = Number(game.appId) || null;
    if (!Number.isInteger(appId) || appId <= 0) {
      try {
        const found = await searchSteamStore(game.name, { country, language });
        if (found?.appId && namesMatch(game.name, found.steamName)) {
          appId = found.appId;
        }
      } catch {
        appId = null;
      }
    }
    if (!appId) return null;
    try {
      const details = await fetchAppDetails(appId, { country, language });
      if (!details?.headerImage) return null;
      return details;
    } catch {
      return null;
    }
  });

  return games
    .map((game, i) => {
      const details = extras[i];
      if (!details?.headerImage) return null;
      const appId = details.appId;
      return {
        rank: game.rank,
        name: details.name || game.name,
        appId,
        owned: ownedIds.has(appId),
        currentPrice: details.currentPrice ?? game.currentPrice ?? null,
        discount: details.discount || game.discount || 0,
        image: details.headerImage,
        headerImage: details.headerImage,
        smallImage: details.headerImage,
        storeUrl: details.storeUrl || `https://store.steampowered.com/app/${appId}`,
        ggDealsUrl: `https://gg.deals/steam/app/${appId}/`,
        source: "gg.deals",
        status: Number(details.discount) > 0 ? "queda" : "igual",
      };
    })
    .filter(Boolean);
}

async function fetchGgDealsPopular({ country, language, ownedIds, previous = [] } = {}) {
  let ranking = [];
  let scraped = false;
  try {
    const result = await scrapeGgDeals();
    ranking = result.games;
    scraped = true;
  } catch {
    ranking = (previous || [])
      .map((game) => ({
        rank: game.rank,
        name: game.name,
        discount: game.discount,
        currentPrice: game.currentPrice,
        ggDealsUrl: game.ggDealsUrl,
        appId: game.appId,
        source: "gg.deals",
      }))
      .filter((game) => game.name);
    if (!ranking.length) {
      ranking = BOOTSTRAP.map((name, i) => ({
        rank: i + 1,
        name,
        ggDealsUrl: `https://gg.deals/game/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/`,
        source: "gg.deals",
      }));
    }
  }

  const games = await enrichWithSteam(ranking.slice(0, 20), {
    country,
    language,
    ownedIds: ownedIds || new Set(),
  });
  return { games, scraped };
}

module.exports = {
  fetchGgDealsPopular,
  parsePopularFromText,
  parsePopularFromHtml,
};
