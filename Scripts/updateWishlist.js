#!/usr/bin/env node
/**
 * Sincroniza a wishlist da Steam e atualiza notas + JSON locais.
 *
 *   npm run update
 *   npm run update:daily
 */

const fs = require("fs/promises");
const path = require("path");
const {
  loadConfig,
  readJson,
  writeJson,
  todayInTimezone,
  nowIso,
  roundMoney,
  formatBRL,
  paint,
} = require("./config");
const { resolveSteamId, fetchWishlist, fetchAppDetails, fetchPriceOverview, fetchReviews, fetchOwnedPlaytimes, fetchMostWanted, fetchStoreHub, mapPool, isRateLimitError, isForbiddenError, capsuleUrl, detectEarlyAccess } = require("./steamApi");
const { refreshBacklog } = require("./backlog");
const { fetchGgDealsPopular, fetchGgDealsDeals, resolveDealLists } = require("./ggDeals");
const { collectWishlistUpdates } = require("./wishlistUpdates");
const { loadHistory, saveHistory, migrateLegacyIfNeeded, appendDaily, summarize, colorStatus, ensureBasePrice } = require("./historyManager");
const { fetchItadPrices } = require("./stores");
const { loadExistingNotes, buildNote, writeGameNote } = require("./notes");
const { writeDashboard, isUnreleased } = require("./dashboard");

function hasFlag(name) {
  return process.argv.includes(name);
}

async function loadTargets(paths, existingNotes) {
  const file = await readJson(paths.targets, {});
  const targets = {};
  for (const [appId, price] of Object.entries(file)) {
    if (price != null) targets[String(appId)] = roundMoney(price);
  }
  for (const [appId, note] of existingNotes.entries()) {
    if (note.fm.target_price != null) targets[String(appId)] = roundMoney(note.fm.target_price);
  }
  return targets;
}

async function localAppIds(paths, existingNotes) {
  const ids = new Set();
  for (const appId of existingNotes.keys()) ids.add(Number(appId));
  const wishlist = await readJson(paths.wishlist, null);
  for (const game of wishlist?.games || []) ids.add(Number(game.appId));
  return [...ids].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
}

function statusPaint(status) {
  if (status === "queda") return paint("green", "● promoção");
  if (status === "alta") return paint("red", "▲ aumentou");
  return paint("blue", "● normal");
}

function savedFromNote(fm) {
  if (!fm) return null;
  const currentPrice = fm.current_price;
  const saleAmount = fm.sale_amount;
  const steamTags = String(fm.steam_tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    name: fm.name,
    headerImage: fm.header_image,
    currentPrice,
    discount: Number(fm.discount || 0),
    initialPrice:
      currentPrice != null && saleAmount
        ? roundMoney(Number(currentPrice) + Number(saleAmount))
        : currentPrice,
    steamTags,
    reviewDesc: fm.review_desc || null,
    reviewPercent: fm.review_percent || null,
    comingSoon: Boolean(fm.coming_soon),
    earlyAccess: detectEarlyAccess({
      earlyAccess: fm.early_access == null || fm.early_access === "" ? undefined : Boolean(fm.early_access),
    }),
    isFree: fm.is_free == null ? undefined : Boolean(fm.is_free),
    nuuvemUrl: fm.nuuvem_url || "",
    gmgUrl: fm.gmg_url || "",
    fanaticalUrl: fm.fanatical_url || "",
    bestStore: fm.best_store || "Steam",
    bestStorePrice: fm.best_store_price ?? currentPrice,
    storeUrl: fm.store_url || "",
  };
}

function isBareSteamHeader(url) {
  return /\/apps\/\d+\/header\.jpg(\?|$)/i.test(String(url || ""));
}

function priceUnchanged(saved, price) {
  if (!saved?.name || !saved.headerImage) return false;
  if (price?.unavailable && saved.currentPrice != null) return true;
  if (price?.currentPrice == null && saved.currentPrice != null) return true;
  return (
    roundMoney(saved.currentPrice) === roundMoney(price?.currentPrice) &&
    Number(saved.discount || 0) === Number(price?.discount || 0)
  );
}

function detailsFromSaved(item, saved, price) {
  return {
    appId: item.appId,
    name: saved.name,
    currentPrice: price?.currentPrice ?? saved.currentPrice,
    initialPrice: price?.initialPrice ?? saved.initialPrice,
    discount: price?.unavailable ? saved.discount : Number(price?.discount ?? saved.discount),
    headerImage: saved.headerImage,
    capsuleImage: saved.headerImage,
    storeUrl: saved.storeUrl || `https://store.steampowered.com/app/${item.appId}`,
    steamTags: saved.steamTags,
    shortDescription: "",
    developers: [],
    publishers: [],
    comingSoon: price?.comingSoon != null ? Boolean(price.comingSoon) : Boolean(saved.comingSoon),
    isFree: price?.isFree != null ? Boolean(price.isFree) : Boolean(saved.isFree),
    releaseDate: price?.releaseDate || saved.releaseDate || "",
    genres: Array.isArray(price?.genres) ? price.genres : saved.genres,
    earlyAccess: detectEarlyAccess({
      earlyAccess: price?.earlyAccess != null ? Boolean(price.earlyAccess) : saved.earlyAccess,
      genres: Array.isArray(price?.genres) ? price.genres : saved.genres,
    }),
  };
}

function maybeUnreleased(saved) {
  if (!saved) return false;
  return isUnreleased(saved);
}

async function writeGgDealsCache(paths, storeHub, stamp) {
  const previous = await readJson(paths.ggDeals, { newDeals: [], bestDeals: [] });
  const lists = resolveDealLists(storeHub, previous);
  storeHub.newDeals = lists.newDeals;
  storeHub.bestDeals = lists.bestDeals;
  await writeJson(paths.ggDeals, {
    updatedAt: stamp,
    source: "gg.deals",
    scraped: Boolean(storeHub.ggDealsScraped),
    newDeals: lists.newDeals,
    bestDeals: lists.bestDeals,
  });
  return lists;
}

function hasSavedNote(saved) {
  return Boolean(saved?.name);
}

function priceLookedRateLimited(price) {
  return Boolean(price?.rateLimited) || isRateLimitError(price?.error);
}

function priceLookedForbidden(price) {
  return Boolean(price?.forbidden) || isForbiddenError(price?.error);
}

function detailsStub(item, saved, price) {
  if (saved) return detailsFromSaved(item, saved, { unavailable: true, ...price, comingSoon: saved.comingSoon, isFree: saved.isFree });
  const header = capsuleUrl(item.appId);
  return {
    appId: item.appId,
    name: price?.name || `App ${item.appId}`,
    currentPrice: price?.currentPrice ?? null,
    initialPrice: price?.initialPrice ?? null,
    discount: Number(price?.discount || 0),
    headerImage: header,
    capsuleImage: header,
    storeUrl: `https://store.steampowered.com/app/${item.appId}`,
    steamTags: [],
    shortDescription: "",
    developers: [],
    publishers: [],
    comingSoon: price?.comingSoon,
    isFree: Boolean(price?.isFree),
    releaseDate: price?.releaseDate || "",
    genres: [],
    earlyAccess: false,
    unavailable: true,
  };
}

async function alreadyRanToday(cachePath, timezone) {
  const cache = await readJson(cachePath, {});
  return cache.lastRunDate === todayInTimezone(timezone);
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
  const emit = typeof onProgress === "function" ? onProgress : () => {};

  function report(phase, current, total, label) {
    const stage = byId[phase] || byId.wishlist;
    const frac = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
    const raw = before[stage.id] + stage.weight * frac;
    try {
      emit({
        phase: stage.id,
        label: label || stage.label,
        current: Number(current) || 0,
        total: Number(total) || 0,
        percent: Math.max(0, Math.min(99, Math.round(raw))),
      });
    } catch {
      // UI progress must not abort the sync
    }
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

async function main(options = {}) {
  const progress = createSyncProgress(options && options.onProgress);
  const daily = hasFlag("--daily");
  const config = await loadConfig();
  const { paths } = config;
  await fs.mkdir(paths.data, { recursive: true });
  await fs.mkdir(paths.games, { recursive: true });
  await fs.mkdir(paths.dashboard, { recursive: true });

  if (daily && (await alreadyRanToday(paths.cache, config.timezone))) {
    console.log(paint("yellow", `Já atualizado hoje (${todayInTimezone(config.timezone)}). Use npm run update para forçar.`));
    return;
  }

  console.log(paint("bold", "Steam Wishlist Dashboard v2 — sincronizando\n"));
  progress.start("wishlist", 4);

  const existingNotes = await loadExistingNotes(paths.games);
  const history = await migrateLegacyIfNeeded(paths, config.timezone);
  const targets = await loadTargets(paths, existingNotes);

  let wishlistItems = [];
  let steamId64 = null;
  let source = "local";
  let ownedIds = new Set();
  let ownedPrivate = true;
  let ownedPayload = null;
  let mostWanted = [];
  let ggPopular = [];
  let storeHub = { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] };

  if (config.steamId || config.profileUrl) {
    steamId64 = await resolveSteamId(config);
    progress.tick("wishlist", 1, 4);
    console.log(paint("dim", `SteamID64: ${steamId64}`));
    wishlistItems = await fetchWishlist(steamId64);
    source = "steam";
    progress.tick("wishlist", 2, 4);
    console.log(paint("cyan", `Wishlist pública: ${wishlistItems.length} jogos`));
    try {
      const owned = await fetchOwnedPlaytimes(steamId64, { apiKey: config.steamWebApiKey });
      ownedPayload = owned;
      ownedIds = new Set((owned.games || []).map((game) => game.appId));
      ownedPrivate = ownedIds.size === 0;
      if (owned.source === "local") {
        console.log(paint("yellow", `Biblioteca via Steam local: ${ownedIds.size} jogos (Detalhes dos jogos ainda privado).`));
      } else if (ownedPrivate) {
        console.log(paint("yellow", "Biblioteca privada — não dá para marcar Comprado. Deixe Detalhes dos jogos públicos."));
      } else {
        console.log(paint("dim", `Biblioteca: ${ownedIds.size} jogos`));
      }
      if (owned.familyFound && owned.familyComplete) {
        console.log(paint("dim", `Steam Family: ${owned.familyCount || 0} jogos só da família`));
      } else if (owned.familyFound) {
        console.log(paint("yellow", "Grupo Família no PC, mas a lista compartilhada não veio — steamWebApiKey e/ou Detalhes dos jogos públicos."));
      } else {
        console.log(paint("yellow", "Steam Family não lido. Chave Web API (steamWebApiKey) e/ou Detalhes dos jogos públicos."));
      }
    } catch (error) {
      console.log(paint("yellow", `Biblioteca: ${error.message}`));
    }
    progress.tick("wishlist", 3, 4);
  } else {
    const ids = await localAppIds(paths, existingNotes);
    wishlistItems = ids.map((appId) => ({ appId, priority: 0, dateAdded: null }));
    progress.tick("wishlist", 3, 4);
    console.log(paint("yellow", "config.json sem steamId — rode conectar-steam.bat\n"));
    if (!wishlistItems.length) {
      throw new Error("Nenhum jogo local e nenhum SteamID. Rode conectar-steam.bat.");
    }
  }

  progress.done("wishlist");
  progress.start("loja", 4);

  try {
    mostWanted = await fetchMostWanted({ country: config.country, language: config.language, limit: 20 });
    mostWanted = mostWanted.map((game) => ({
      ...game,
      owned: ownedIds.has(game.appId),
      onWishlist: wishlistItems.some((item) => item.appId === game.appId),
    }));
    console.log(paint("cyan", `Mais visados: ${mostWanted.slice(0, 8).map((g) => g.name).join(", ")}…`));
  } catch (error) {
    const prevWanted = await readJson(paths.mostWanted, { games: [] });
    mostWanted = prevWanted.games || [];
    console.log(paint("yellow", `Mais visados indisponíveis: ${error.message}`));
  }
  progress.tick("loja", 1, 4);

  try {
    storeHub = await fetchStoreHub({ country: config.country, language: config.language });
    const mark = (list) =>
      (list || []).map((item) => ({
        ...item,
        owned: item.appId ? ownedIds.has(item.appId) : false,
      }));
    storeHub = {
      events: storeHub.events || [],
      specials: mark(storeHub.specials),
      newDeals: [],
      bestDeals: [],
      dealsStrip: mark(storeHub.dealsStrip),
    };
    console.log(
      paint(
        "cyan",
        `Steam hub: ${storeHub.events.length} eventos · ${storeHub.dealsStrip.length} na faixa de descontos`
      )
    );
  } catch (error) {
    console.log(paint("yellow", `Destaques Steam indisponíveis: ${error.message}\n`));
  }
  progress.tick("loja", 2, 4);

  try {
    const previousGg = await readJson(paths.ggPopular, { games: [] });
    const gg = await fetchGgDealsPopular({
      country: config.country,
      language: config.language,
      ownedIds,
      previous: previousGg.games || [],
    });
    ggPopular = gg.games;
    console.log(
      paint(
        "cyan",
        `gg.deals Most Popular: ${ggPopular.slice(0, 6).map((g) => g.name).join(", ")}…${gg.scraped ? "" : " (ranking em cache, preços atualizados)"}`
      )
    );
  } catch (error) {
    console.log(paint("yellow", `gg.deals Most Popular indisponível: ${error.message}`));
  }
  progress.tick("loja", 3, 4);

  try {
    const previousDeals = await readJson(paths.ggDeals, { newDeals: [], bestDeals: [] });
    const deals = await fetchGgDealsDeals({
      country: config.country,
      language: config.language,
      ownedIds,
      previous: previousDeals,
      knownGames: [...ggPopular, ...mostWanted],
    });
    const lists = resolveDealLists(deals, previousDeals);
    storeHub = {
      ...storeHub,
      newDeals: lists.newDeals,
      bestDeals: lists.bestDeals,
      ggDealsUsd: deals.usdOnly,
      ggDealsScraped: deals.scraped,
    };
    const preview = (list) => (list || []).slice(0, 5).map((g) => g.name).join(", ");
    if (deals.scraped) {
      console.log(
        paint(
          "cyan",
          `gg.deals New deals: ${preview(deals.newDeals)}… · Best deals: ${preview(deals.bestDeals)}…`
        )
      );
    } else {
      console.log(
        paint(
          "yellow",
          `gg.deals New/Best deals: scrape bloqueado — usando cache (${lists.newDeals.length} + ${lists.bestDeals.length} jogos)`
        )
      );
    }
  } catch (error) {
    const previousDeals = await readJson(paths.ggDeals, { newDeals: [], bestDeals: [] });
    const lists = resolveDealLists({}, previousDeals);
    storeHub = {
      ...storeHub,
      newDeals: lists.newDeals,
      bestDeals: lists.bestDeals,
      ggDealsUsd: false,
      ggDealsScraped: false,
    };
    console.log(paint("yellow", `gg.deals New/Best deals indisponível: ${error.message}`));
  }
  progress.done("loja");

  if (hasFlag("--panel-only")) {
    progress.done("precos");
    for (const bucket of Object.values(history.games)) {
      ensureBasePrice(bucket);
    }
    await saveHistory(paths.history, history);

    const gamesFromNotes = [...existingNotes.values()]
      .map(({ fm }) => {
        const appId = Number(fm.steam_appid);
        const key = String(appId);
        const bucket = history.games[key] || { appId, entries: [] };
        history.games[key] = bucket;
        ensureBasePrice(bucket, {
          currentPrice: fm.current_price,
          discount: fm.discount,
          initialPrice:
            fm.current_price != null && fm.sale_amount
              ? roundMoney(Number(fm.current_price) + Number(fm.sale_amount))
              : fm.current_price,
        });
        const initialPrice =
          fm.current_price != null && fm.sale_amount
            ? roundMoney(Number(fm.current_price) + Number(fm.sale_amount))
            : fm.current_price;
        return {
          appId,
          name: fm.name,
          headerImage: fm.header_image,
          currentPrice: fm.current_price,
          previousPrice: fm.previous_price,
          priceDiff: fm.price_diff,
          discount: fm.discount,
          basePrice: bucket.basePrice ?? fm.base_price,
          status: colorStatus({
            currentPrice: fm.current_price,
            discount: fm.discount,
            initialPrice,
            basePrice: bucket.basePrice ?? fm.base_price,
          }),
          onWishlist: fm.on_wishlist !== false,
          owned: Boolean(fm.owned),
          comingSoon: fm.coming_soon == null || fm.coming_soon === "" ? null : Boolean(fm.coming_soon),
          earlyAccess: detectEarlyAccess({
            earlyAccess: fm.early_access == null || fm.early_access === "" ? undefined : Boolean(fm.early_access),
          }),
          isFree: fm.is_free == null ? fm.current_price === 0 : Boolean(fm.is_free),
          releaseDate: fm.release_date || "",
          storeUrl: fm.store_url,
          updatedAt: fm.updated || nowIso(),
        };
      })
      .filter((game) => Number.isInteger(game.appId) && game.appId > 0);
    await saveHistory(paths.history, history);
    const stamp = nowIso();
    await writeJson(paths.mostWanted, { updatedAt: stamp, games: mostWanted });
    await writeJson(paths.ggPopular, {
      updatedAt: stamp,
      source: "gg.deals",
      games: ggPopular,
    });
    const ggLists = await writeGgDealsCache(paths, storeHub, stamp);
    await writeJson(paths.storeHub, { updatedAt: stamp, ...storeHub, newDeals: ggLists.newDeals, bestDeals: ggLists.bestDeals });
    const previousWish = await readJson(paths.wishlist, { games: [] });
    progress.start("noticias", gamesFromNotes.length || 1);
    const updates = await collectWishlistUpdates({
      paths,
      games: gamesFromNotes,
      previousWishlist: previousWish.games || [],
      timezone: config.timezone,
      language: config.language,
      refreshNews: false,
      onProgress: (p) => progress.tick("noticias", p.current, p.total),
    });
    await writeDashboard(gamesFromNotes, config, {
      mostWanted,
      ggPopular,
      ownedPrivate,
      storeHub,
      ggDeals: ggLists,
      wishlistUpdates: updates.events,
      updatedAt: stamp,
    });
    progress.done("noticias");
    progress.start("backlog");
    const backlog = await refreshBacklog({
      config,
      steamId64,
      ownedPayload,
      onProgress: (p) => progress.tick("backlog", p.current, p.total, p.label),
    });
    progress.done("backlog");
    const wishCount = gamesFromNotes.filter((game) => game.onWishlist).length;
    console.log(paint("green", `Painel redesenhado com ${wishCount} jogos (sem reconsultar cada preço).`));
    if (updates.newsLimited) {
      console.log(paint("yellow", "Atualizações Steam: 429 — usando o que já estava no cache de 7 dias."));
    } else if (updates.newsSkipped) {
      console.log(paint("dim", `Wishlist: ${updates.events.length} atualizações em cache (7 dias).`));
    } else {
      console.log(paint("cyan", `Wishlist: ${updates.events.length} atualizações nos últimos 7 dias.`));
    }
    console.log(
      paint(
        "green",
        `Backlog: ${backlog.open.length} na lista · Não vou jogar: ${backlog.done.length}` +
          (backlog.payload?.source === "local" ? " (horas do Steam local)" : "")
      )
    );
    return {
      panelOnly: true,
      wishCount,
      events: updates.events || [],
      freshCount: updates.freshCount || 0,
      backlogOpen: backlog.open.length,
      backlogDone: backlog.done.length,
    };
  }

  const wishlistIds = new Set(wishlistItems.map((item) => item.appId));
  const savedWishlist = await readJson(paths.wishlist, { games: [] });
  const previousList = savedWishlist.games?.length
    ? savedWishlist.games.map((game) => Number(game.appId))
    : [...existingNotes.keys()];
  const previousIds = new Set(previousList);

  const added = [...wishlistIds].filter((id) => !previousIds.has(id));
  const removed = [...previousIds].filter((id) => !wishlistIds.has(id));
  if (added.length) console.log(paint("green", `Adicionados: ${added.join(", ")}`));
  if (removed.length) console.log(paint("red", `Removidos da wishlist: ${removed.join(", ")}`));
  if (added.length || removed.length) console.log("");

  const today = todayInTimezone(config.timezone);
  const updatedAt = nowIso();
  const gamesOut = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let changed = 0;
  let recovered429 = 0;
  let recovered403 = 0;

  const PRICE_CONCURRENCY = 7;
  const STEAM_429_TRIP = 4;
  const steamLimit = { hits: 0, tripped: false, logged: false };
  function noteSteam429() {
    steamLimit.hits += 1;
    if (steamLimit.hits >= STEAM_429_TRIP) steamLimit.tripped = true;
  }
  function logSteamLimitedOnce() {
    if (!steamLimit.logged && steamLimit.tripped) {
      steamLimit.logged = true;
      console.log(paint("yellow", "Steam limitou; resto em cache"));
    }
  }

  console.log(paint("dim", `Checando ${wishlistItems.length} preços em paralelo...`));
  const priceTotal = Math.max(1, wishlistItems.length * 2);
  progress.start("precos", priceTotal);
  const priceHits = await mapPool(wishlistItems, PRICE_CONCURRENCY, async (item) => {
    if (steamLimit.tripped) {
      logSteamLimitedOnce();
      return { appId: item.appId, unavailable: true, rateLimited: true };
    }
    try {
      return await fetchPriceOverview(item.appId, config);
    } catch (error) {
      const limited = isRateLimitError(error);
      const forbidden = isForbiddenError(error);
      if (limited) {
        noteSteam429();
        logSteamLimitedOnce();
      }
      return {
        appId: item.appId,
        error: error.message,
        unavailable: true,
        rateLimited: limited,
        forbidden,
      };
    }
  }, (done) => progress.tick("precos", done, priceTotal));

  for (let i = 0; i < wishlistItems.length; i += 1) {
    const item = wishlistItems[i];
    const saved = savedFromNote(existingNotes.get(item.appId)?.fm);
    const price = priceHits[i] || {};
    process.stdout.write(paint("dim", `[${i + 1}/${wishlistItems.length}] ${item.appId} `));
    try {
      let details;
      let reviews = {
        reviewDesc: saved?.reviewDesc || null,
        reviewPercent: saved?.reviewPercent || null,
        reviewTotal: null,
      };
      let stores = {
        nuuvem: saved?.nuuvemUrl,
        gmg: saved?.gmgUrl,
        fanatical: saved?.fanaticalUrl,
        bestStore: saved?.bestStore || "Steam",
        bestStorePrice: saved?.bestStorePrice ?? saved?.currentPrice,
      };
      let reuse = priceUnchanged(saved, price);
      let from429 = false;
      let from403 = false;
      let headerUpgraded = false;
      const known = hasSavedNote(saved);
      const price429 = priceLookedRateLimited(price);
      const price403 = priceLookedForbidden(price);
      const cacheableMiss = price429 || price403 || (price.unavailable && price.error);

      if (!reuse && known && cacheableMiss) {
        reuse = true;
        from429 = price429;
        from403 = price403;
      }

      if (
        reuse &&
        known &&
        !from429 &&
        !from403 &&
        !price429 &&
        !price403 &&
        !steamLimit.tripped &&
        (maybeUnreleased(saved) || detectEarlyAccess(saved))
      ) {
        reuse = false;
      }

      if (reuse) {
        details = detailsFromSaved(item, saved, from429 || from403 ? { unavailable: true } : price);
        skipped += 1;
        if (from429) recovered429 += 1;
        if (from403) recovered403 += 1;

        if (
          !from429 &&
          !from403 &&
          !steamLimit.tripped &&
          isBareSteamHeader(details.headerImage)
        ) {
          try {
            const fresh = await fetchAppDetails(item.appId, config);
            if (fresh?.headerImage) {
              details.headerImage = fresh.headerImage;
              details.capsuleImage = fresh.capsuleImage || fresh.headerImage;
              headerUpgraded = true;
            }
            if (fresh && !fresh.unavailable) {
              details.earlyAccess = Boolean(fresh.earlyAccess);
              if (Array.isArray(fresh.genres)) details.genres = fresh.genres;
            }
          } catch (error) {
            if (isRateLimitError(error)) {
              noteSteam429();
              logSteamLimitedOnce();
            }
          }
        }
      } else if (steamLimit.tripped && known) {
        details = detailsFromSaved(item, saved, price);
        skipped += 1;
      } else {
        try {
          details = await fetchAppDetails(item.appId, config);
        } catch (error) {
          const limited = isRateLimitError(error);
          const forbidden = isForbiddenError(error);
          if (limited) {
            noteSteam429();
            logSteamLimitedOnce();
          }
          if (!known && !limited && !forbidden) throw error;
          details = detailsStub(item, saved, { unavailable: true, ...price });
          reuse = true;
          from429 = limited;
          from403 = forbidden;
          skipped += 1;
          if (from429) recovered429 += 1;
          if (from403) recovered403 += 1;
        }

        if (!reuse && details.unavailable && known) {
          details = detailsFromSaved(item, saved, { unavailable: true });
          reuse = true;
          skipped += 1;
        } else if (!reuse) {
          if (details.currentPrice == null && saved?.currentPrice != null) {
            details.currentPrice = saved.currentPrice;
            details.initialPrice = saved.initialPrice ?? details.initialPrice;
            details.discount = saved.discount;
          }
          if (details.comingSoon == null && saved?.comingSoon != null) {
            details.comingSoon = saved.comingSoon;
          }
          reviews = await fetchReviews(item.appId);
          stores = await fetchItadPrices(item.appId, details.name, {
            apiKey: config.itadApiKey,
            country: config.country.toUpperCase() === "BR" ? "BR" : config.country,
            steamPrice: details.currentPrice,
          });
          changed += 1;
        }
      }

      appendDaily(history, details, config.timezone);
      const bucket = history.games[String(item.appId)];
      const stats = summarize(bucket.entries, today, { basePrice: bucket.basePrice });
      const targetPrice = targets[String(item.appId)] ?? null;
      const belowTarget =
        stats.currentPrice != null && targetPrice != null && stats.currentPrice <= targetPrice;

      const game = {
        ...details,
        ...stats,
        ...reviews,
        targetPrice,
        belowTarget,
        onWishlist: true,
        owned: ownedIds.has(item.appId),
        priority: item.priority,
        dateAdded: item.dateAdded,
        nuuvemUrl: stores.nuuvem || stores.nuuvemUrl || saved?.nuuvemUrl,
        gmgUrl: stores.gmg || stores.gmgUrl || saved?.gmgUrl,
        fanaticalUrl: stores.fanatical || stores.fanaticalUrl || saved?.fanaticalUrl,
        bestStore: stores.bestStore,
        bestStorePrice: stores.bestStorePrice,
        updatedAt,
      };

      const existing = existingNotes.get(item.appId);
      if (!reuse || headerUpgraded || (!existing && (from403 || from429))) {
        await writeGameNote(
          paths.games,
          buildNote(game, {
            previousFileName: existing?.fileName,
            userNotes: existing?.userNotes || "",
          })
        );
      }

      gamesOut.push(game);
      const cacheTag = from403
        ? paint("yellow", "  403 · cache")
        : from429
          ? paint("yellow", "  429 · cache")
          : reuse
            ? paint("dim", "  cache")
            : "";
      console.log(
        `${paint("bold", details.name)}  ${details.currentPrice == null ? "—" : formatBRL(details.currentPrice)}  ${statusPaint(stats.status)}` +
          (stats.discount ? paint("yellow", `  -${stats.discount}%`) : "") +
          cacheTag
      );
      ok += 1;
    } catch (error) {
      failed += 1;
      console.log(paint("red", `falhou: ${error.message}`));
    }
    progress.tick("precos", wishlistItems.length + i + 1, priceTotal);
  }

  for (const appId of removed) {
    const existing = existingNotes.get(appId);
    const bucket = history.games[String(appId)];
    if (!existing && !bucket) continue;
    const stats = summarize(bucket?.entries || [], today, { basePrice: bucket?.basePrice });
    const game = {
      appId,
      name: bucket?.name || existing?.fm?.name || `App ${appId}`,
      headerImage: existing?.fm?.header_image || null,
      storeUrl: `https://store.steampowered.com/app/${appId}`,
      steamTags: String(existing?.fm?.steam_tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      reviewDesc: existing?.fm?.review_desc || null,
      reviewPercent: existing?.fm?.review_percent || null,
      ...stats,
      targetPrice: targets[String(appId)] ?? null,
      belowTarget: false,
      onWishlist: false,
      owned: ownedIds.has(appId),
      nuuvemUrl: existing?.fm?.nuuvem_url || "",
      gmgUrl: existing?.fm?.gmg_url || "",
      fanaticalUrl: existing?.fm?.fanatical_url || "",
      bestStore: existing?.fm?.best_store || "Steam",
      bestStorePrice: existing?.fm?.best_store_price ?? stats.currentPrice,
      updatedAt,
    };
    await writeGameNote(
      paths.games,
      buildNote(game, {
        previousFileName: existing?.fileName,
        userNotes: existing?.userNotes || "",
      })
    );
  }

  await saveHistory(paths.history, history);
  await writeJson(paths.wishlist, {
    lastUpdate: updatedAt,
    lastRunDate: today,
    source,
    steamId64,
    currency: config.currency,
    added,
    removed,
    games: gamesOut.map((game) => ({
      appId: game.appId,
      name: game.name,
      currentPrice: game.currentPrice,
      previousPrice: game.previousPrice,
      priceDiff: game.priceDiff,
      discount: game.discount,
      lowestPrice: game.lowestPrice,
      status: game.status,
      owned: game.owned,
      onSale: game.onSale,
      reviewDesc: game.reviewDesc,
      reviewPercent: game.reviewPercent,
      steamTags: game.steamTags,
      daysSinceSale: game.daysSinceSale,
      headerImage: game.headerImage,
      storeUrl: game.storeUrl,
      comingSoon: Boolean(game.comingSoon),
      isFree: Boolean(game.isFree || game.currentPrice === 0),
      releaseDate: game.releaseDate || "",
      genres: Array.isArray(game.genres) ? game.genres : undefined,
      earlyAccess: Boolean(game.earlyAccess),
      updatedAt: game.updatedAt,
    })),
  });
  await writeJson(paths.cache, {
    lastRunDate: today,
    lastUpdate: updatedAt,
    source,
    ok,
    failed,
  });
  await writeJson(paths.owned, {
    updatedAt,
    privateProfile: ownedPrivate,
    count: ownedIds.size,
    appIds: [...ownedIds],
  });
  await writeJson(paths.mostWanted, {
    updatedAt,
    source: "steam-popularwishlist",
    notice: "Lista pública de mais desejados da Steam (mesmo tipo de ranking do gg.deals). A API do gg.deals não entrega wishlist/biblioteca pessoal.",
    games: mostWanted,
  });
  await writeJson(paths.ggPopular, {
    updatedAt,
    source: "gg.deals",
    games: ggPopular,
  });
  const ggLists = await writeGgDealsCache(paths, storeHub, updatedAt);
  await writeJson(paths.storeHub, { updatedAt, ...storeHub, newDeals: ggLists.newDeals, bestDeals: ggLists.bestDeals });
  progress.done("precos");
  progress.start("noticias", gamesOut.length || 1);
  const updates = await collectWishlistUpdates({
    paths,
    games: gamesOut,
    previousWishlist: savedWishlist.games || [],
    timezone: config.timezone,
    language: config.language,
    refreshNews: true,
    onProgress: (p) => progress.tick("noticias", p.current, p.total),
  });
  await writeDashboard(gamesOut, config, {
    mostWanted,
    ggPopular,
    ownedPrivate,
    storeHub,
    ggDeals: ggLists,
    wishlistUpdates: updates.events,
    updatedAt,
  });
  progress.done("noticias");
  progress.start("backlog");
  const backlog = await refreshBacklog({
    config,
    steamId64,
    ownedPayload,
    onProgress: (p) => progress.tick("backlog", p.current, p.total, p.label),
  });
  progress.done("backlog");

  console.log("");
  console.log(
    paint(
      "cyan",
      `Atualizados: ${ok}  |  Iguais (cache): ${skipped}  |  Mudou/novo: ${changed}  |  Falhas: ${failed}` +
        (recovered429 ? `  |  429 recuperados do cache: ${recovered429}` : "") +
        (recovered403 ? `  |  403 recuperados do cache: ${recovered403}` : "")
    )
  );
  console.log(
    paint(
      "green",
      `Backlog: ${backlog.open.length} na lista · Não vou jogar: ${backlog.done.length}`
    )
  );
  if (updates.newsLimited) {
    console.log(paint("yellow", "Atualizações Steam: 429 — usando o cache da wishlist."));
  } else {
    console.log(paint("cyan", `Wishlist: ${updates.events.length} atualizações nos últimos 7 dias.`));
  }
  return {
    panelOnly: false,
    wishCount: gamesOut.filter((game) => game.onWishlist).length,
    events: updates.events || [],
    freshCount: updates.freshCount || 0,
    backlogOpen: backlog.open.length,
    backlogDone: backlog.done.length,
  };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(paint("red", error.stack || error.message));
    process.exitCode = 1;
  });
}

module.exports = { run: main };
