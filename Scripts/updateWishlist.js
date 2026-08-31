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
const { resolveSteamId, fetchWishlist, fetchAppDetails, fetchPriceOverview, fetchReviews, fetchOwnedGames, fetchMostWanted, fetchStoreHub, mapPool } = require("./steamApi");
const { fetchGgDealsPopular } = require("./ggDeals");
const { loadHistory, saveHistory, migrateLegacyIfNeeded, appendDaily, summarize, colorStatus, ensureBasePrice } = require("./historyManager");
const { fetchItadPrices } = require("./stores");
const { loadExistingNotes, buildNote, writeGameNote } = require("./notes");
const { writeDashboard } = require("./dashboard");

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
  return {
    name: fm.name,
    headerImage: fm.header_image,
    currentPrice,
    discount: Number(fm.discount || 0),
    initialPrice:
      currentPrice != null && saleAmount
        ? roundMoney(Number(currentPrice) + Number(saleAmount))
        : currentPrice,
    steamTags: String(fm.steam_tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    reviewDesc: fm.review_desc || null,
    reviewPercent: fm.review_percent || null,
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
  if (isBareSteamHeader(saved.headerImage)) return false;
  if (price?.unavailable && saved.currentPrice != null) return true;
  if (price?.currentPrice == null && saved.currentPrice != null) return true;
  return (
    roundMoney(saved.currentPrice) === roundMoney(price?.currentPrice) &&
    Number(saved.discount || 0) === Number(price?.discount || 0)
  );
}

async function alreadyRanToday(cachePath, timezone) {
  const cache = await readJson(cachePath, {});
  return cache.lastRunDate === todayInTimezone(timezone);
}

async function main() {
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

  const existingNotes = await loadExistingNotes(paths.games);
  const history = await migrateLegacyIfNeeded(paths, config.timezone);
  const targets = await loadTargets(paths, existingNotes);

  let wishlistItems = [];
  let steamId64 = null;
  let source = "local";
  let ownedIds = new Set();
  let ownedPrivate = true;
  let mostWanted = [];
  let ggPopular = [];
  let storeHub = { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] };

  if (config.steamId || config.profileUrl) {
    steamId64 = await resolveSteamId(config);
    console.log(paint("dim", `SteamID64: ${steamId64}`));
    wishlistItems = await fetchWishlist(steamId64);
    source = "steam";
    console.log(paint("cyan", `Wishlist pública: ${wishlistItems.length} jogos`));
    try {
      const owned = await fetchOwnedGames(steamId64);
      ownedIds = owned.ids;
      ownedPrivate = owned.privateProfile;
      console.log(
        ownedPrivate
          ? paint("yellow", "Biblioteca privada — não dá para marcar Comprado. Deixe Detalhes dos jogos públicos.")
          : paint("dim", `Biblioteca: ${ownedIds.size} jogos`)
      );
    } catch (error) {
      console.log(paint("yellow", `Biblioteca: ${error.message}`));
    }
  } else {
    const ids = await localAppIds(paths, existingNotes);
    wishlistItems = ids.map((appId) => ({ appId, priority: 0, dateAdded: null }));
    console.log(paint("yellow", "config.json sem steamId — rode conectar-steam.bat\n"));
    if (!wishlistItems.length) {
      throw new Error("Nenhum jogo local e nenhum SteamID. Rode conectar-steam.bat.");
    }
  }

  try {
    mostWanted = await fetchMostWanted({ country: config.country, language: config.language, limit: 20 });
    mostWanted = mostWanted.map((game) => ({
      ...game,
      owned: ownedIds.has(game.appId),
      onWishlist: wishlistItems.some((item) => item.appId === game.appId),
    }));
    console.log(paint("cyan", `Mais visados: ${mostWanted.slice(0, 8).map((g) => g.name).join(", ")}…`));
  } catch (error) {
    console.log(paint("yellow", `Mais visados indisponíveis: ${error.message}`));
  }

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
      newDeals: mark(storeHub.newDeals),
      bestDeals: mark(storeHub.bestDeals),
      dealsStrip: mark(storeHub.dealsStrip),
    };
    console.log(
      paint(
        "cyan",
        `Steam hub: ${storeHub.events.length} eventos · ${storeHub.dealsStrip.length} na faixa de descontos · ${storeHub.newDeals.length} new deals · ${storeHub.bestDeals.length} best deals\n`
      )
    );
  } catch (error) {
    console.log(paint("yellow", `Destaques Steam indisponíveis: ${error.message}\n`));
  }

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

  if (hasFlag("--panel-only")) {
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
    await writeJson(paths.storeHub, { updatedAt: stamp, ...storeHub });
    await writeDashboard(gamesFromNotes, config, {
      mostWanted,
      ggPopular,
      ownedPrivate,
      storeHub,
      updatedAt: stamp,
    });
    const wishCount = gamesFromNotes.filter((game) => game.onWishlist).length;
    console.log(paint("green", `Painel redesenhado com ${wishCount} jogos (sem reconsultar cada preço).`));
    return;
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

  console.log(paint("dim", `Checando ${wishlistItems.length} preços em paralelo...`));
  const priceHits = await mapPool(wishlistItems, 8, async (item) => {
    try {
      return await fetchPriceOverview(item.appId, config);
    } catch (error) {
      return { appId: item.appId, error: error.message, unavailable: true };
    }
  });

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
      const reuse = priceUnchanged(saved, price);

      if (reuse) {
        details = {
          appId: item.appId,
          name: saved.name,
          currentPrice: price.currentPrice ?? saved.currentPrice,
          initialPrice: price.initialPrice ?? saved.initialPrice,
          discount: price.unavailable ? saved.discount : Number(price.discount ?? saved.discount),
          headerImage: saved.headerImage,
          capsuleImage: saved.headerImage,
          storeUrl: saved.storeUrl || `https://store.steampowered.com/app/${item.appId}`,
          steamTags: saved.steamTags,
          shortDescription: "",
          developers: [],
          publishers: [],
          comingSoon: false,
        };
        skipped += 1;
      } else {
        details = await fetchAppDetails(item.appId, config);
        if (details.currentPrice == null && saved?.currentPrice != null) {
          details.currentPrice = saved.currentPrice;
          details.initialPrice = saved.initialPrice ?? details.initialPrice;
          details.discount = saved.discount;
        }
        reviews = await fetchReviews(item.appId);
        stores = await fetchItadPrices(item.appId, details.name, {
          apiKey: config.itadApiKey,
          country: config.country.toUpperCase() === "BR" ? "BR" : config.country,
          steamPrice: details.currentPrice,
        });
        changed += 1;
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
      if (!reuse) {
        await writeGameNote(
          paths.games,
          buildNote(game, {
            previousFileName: existing?.fileName,
            userNotes: existing?.userNotes || "",
          })
        );
      }

      gamesOut.push(game);
      console.log(
        `${paint("bold", details.name)}  ${details.currentPrice == null ? "—" : formatBRL(details.currentPrice)}  ${statusPaint(stats.status)}` +
          (stats.discount ? paint("yellow", `  -${stats.discount}%`) : "") +
          (reuse ? paint("dim", "  cache") : "")
      );
      ok += 1;
    } catch (error) {
      failed += 1;
      console.log(paint("red", `falhou: ${error.message}`));
    }
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
  await writeJson(paths.storeHub, { updatedAt, ...storeHub });
  await writeDashboard(gamesOut, config, { mostWanted, ggPopular, ownedPrivate, storeHub, updatedAt });

  console.log("");
  console.log(
    paint("cyan", `Atualizados: ${ok}  |  Iguais (cache): ${skipped}  |  Mudou/novo: ${changed}  |  Falhas: ${failed}`)
  );
}

main().catch((error) => {
  console.error(paint("red", error.stack || error.message));
  process.exitCode = 1;
});
