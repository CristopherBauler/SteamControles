function searchLinks(name, appId) {
  const query = encodeURIComponent(name || "");
  return {
    steam: `https://store.steampowered.com/app/${appId}`,
    nuuvem: `https://www.nuuvem.com/pt-br/catalog/search/${query}`,
    gmg: `https://www.greenmangaming.com/search?query=${query}`,
    fanatical: `https://www.fanatical.com/en/search?search=${query}`,
  };
}

const WANTED_SHOPS = new Set(["nuuvem", "green man gaming", "fanatical", "steam"]);

function pickBest(deals, steamPrice) {
  const priced = deals.filter((deal) => deal.price != null);
  if (steamPrice != null) {
    priced.push({ shop: "Steam", price: steamPrice, url: null });
  }
  if (!priced.length) return { bestStore: "Steam", bestStorePrice: steamPrice };
  priced.sort((a, b) => a.price - b.price);
  return { bestStore: priced[0].shop, bestStorePrice: priced[0].price };
}

async function fetchItadPrices(appId, name, { apiKey, country, steamPrice }) {
  const links = searchLinks(name, appId);
  const empty = {
    ...links,
    nuuvemPrice: null,
    gmgPrice: null,
    fanaticalPrice: null,
    bestStore: "Steam",
    bestStorePrice: steamPrice,
  };
  if (!apiKey) return empty;

  try {
    const lookupUrl = `https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(apiKey)}&appid=${appId}`;
    const lookup = await fetch(lookupUrl, { signal: AbortSignal.timeout(15000) });
    if (!lookup.ok) return empty;
    const looked = await lookup.json();
    const gameId = looked?.found ? looked?.game?.id : looked?.id;
    if (!gameId) return empty;

    const response = await fetch(
      `https://api.isthereanydeal.com/games/prices/v3?key=${encodeURIComponent(apiKey)}&country=${country || "BR"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify([gameId]),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!response.ok) return empty;
    const payload = await response.json();
    const deals = [];
    const list = Array.isArray(payload) ? payload : payload?.[gameId] || payload?.data || [];
    const shops = list[0]?.deals || list[0]?.shops || list;

    if (Array.isArray(shops)) {
      for (const deal of shops) {
        const shopName = String(deal?.shop?.name || deal?.store?.name || "").trim();
        if (!shopName || !WANTED_SHOPS.has(shopName.toLowerCase())) continue;
        const price = deal?.price?.amount ?? deal?.current?.price;
        deals.push({
          shop: shopName,
          price: price == null ? null : Number(price),
          url: deal?.url || deal?.deal?.url || null,
        });
      }
    }

    const byName = (label) =>
      deals.find((deal) => deal.shop.toLowerCase() === label)?.price ?? null;

    return {
      ...links,
      nuuvemPrice: byName("nuuvem"),
      gmgPrice: byName("green man gaming"),
      fanaticalPrice: byName("fanatical"),
      ...pickBest(deals, steamPrice),
    };
  } catch {
    return empty;
  }
}

module.exports = {
  searchLinks,
  fetchItadPrices,
};
