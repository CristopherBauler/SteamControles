/**
 * Painel visual: faixas horizontais com rolagem nativa.
 * CSS extra em .obsidian/snippets/game-wishlist-dashboard.css
 */

const fs = require("fs/promises");
const path = require("path");
const { formatBRL, readJson } = require("./config");
const { resolveDealLists } = require("./ggDeals");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function badgeText(iso, timezone) {
  if (!iso) return "Sem atualização";
  const date = new Date(iso);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return day === today ? `Atualizado hoje ${hora}` : `Atualizado ${day.slice(8, 10)}/${day.slice(5, 7)} ${hora}`;
}

const PRICE_COLOR = { queda: "#3dd68c", alta: "#ff6b6b", igual: "#4da3ff" };

function cover(game) {
  return game?.headerImage || game?.image || "";
}

function check(owned) {
  return owned
    ? `<span class="gwd-check" title="Na biblioteca">✓</span>`
    : "";
}

function discTag(discount) {
  if (!Number(discount)) return "";
  return `<span class="gwd-disc">-${esc(discount)}%</span>`;
}

function listTone(game) {
  if (game.currentPrice === 0) return "queda";
  if (Number(game.discount) > 0) return "queda";
  return game.status || "igual";
}

function isUnreleased(game) {
  if (game.comingSoon === true) return true;
  if (game.comingSoon === false) return false;
  if (Number(game.discount) > 0 && game.currentPrice > 0) return false;
  return game.currentPrice == null || game.currentPrice === 0;
}

function priceLine(game, { soon } = {}) {
  if (soon) return `<span class="gwd-soon">Em breve</span>`;
  const status = listTone(game);
  const color = PRICE_COLOR[status] || PRICE_COLOR.igual;
  const price =
    game.currentPrice === 0
      ? `<span style="color:#3dd68c;font-weight:700">Free</span>`
      : `<span style="color:${color};font-weight:700">${esc(formatBRL(game.currentPrice))}</span>`;
  return `${price} ${discTag(game.discount)}`;
}

function sectionHead(title, extra = "", link = null) {
  const bits = [];
  if (extra) bits.push(esc(extra));
  if (link?.href) {
    bits.push(`<a class="gwd-seclink" href="${esc(link.href)}">${esc(link.label || "Ver no gg.deals")}</a>`);
  }
  return `<div class="gwd-sechead">
    <div class="gwd-sectitle">${esc(title)}</div>
    <div class="gwd-secextra">${bits.join(" · ")}</div>
  </div>`;
}

function wishStrip(title, extra, cardsHtml) {
  return `${sectionHead(title, extra)}
  ${scrollRow(cardsHtml)}`;
}

function scrollRow(cardsHtml) {
  if (!cardsHtml) return `<div class="gwd-empty">Nada para mostrar agora.</div>`;
  return `<div class="gwd-scroller"><div class="gwd-track">${cardsHtml}</div></div>`;
}

function gameCard(game, { rank, href, soon } = {}) {
  const img = cover(game);
  const art = img
    ? `<img src="${esc(img)}" alt="">`
    : `<div class="gwd-card-ph"></div>`;
  const link = href || game.storeUrl || "#";
  return `<a class="gwd-card" href="${esc(link)}">
    <div class="gwd-card-art">
      ${art}
      ${rank != null ? `<span class="gwd-rank">#${rank}</span>` : ""}
    </div>
    <div class="gwd-card-name">${check(game.owned)}${esc(game.name)}</div>
    <div class="gwd-card-price">${priceLine(game, { soon })}</div>
  </a>`;
}

function ggCard(game) {
  const img = cover(game);
  const art = img ? `<img src="${esc(img)}" alt="">` : `<div class="gwd-gg-ph"></div>`;
  const link = game.storeUrl || game.ggDealsUrl || "#";
  const price =
    game.currentPrice === 0
      ? `<span class="gwd-from-free">Free</span>`
      : game.currentPrice != null
        ? `<span class="gwd-from-val" style="color:${PRICE_COLOR[listTone(game)]}">${esc(formatBRL(game.currentPrice))}</span>`
        : `<span class="gwd-from-val">—</span>`;
  return `<a class="gwd-gg" href="${esc(link)}">
    <div class="gwd-gg-art">
      ${art}
      ${game.rank != null ? `<span class="gwd-rank gwd-rank-br">#${game.rank}</span>` : ""}
    </div>
    <div class="gwd-gg-name">${check(game.owned)}${esc(game.name)}</div>
    <div class="gwd-gg-from"><span class="gwd-from-lbl">From:</span> ${price} ${discTag(game.discount)}</div>
  </a>`;
}

function eventBanner(event) {
  if (!event?.image) return "";
  return `<a class="gwd-ev" href="${esc(event.url)}">
    <img src="${esc(event.image)}" alt="">
    <div class="gwd-ev-cap">
      <div class="gwd-ev-name">${esc(event.name)}</div>
      ${event.body ? `<div class="gwd-ev-body">${esc(event.body)}</div>` : ""}
    </div>
  </a>`;
}

function dealPrice(game) {
  if (game.currentPrice === 0 || /^free$/i.test(game.priceLabel || "")) {
    return `<span style="color:#3dd68c;font-weight:700">Free</span>`;
  }
  if (game.currency === "USD" && (game.usdPrice != null || game.currentPrice != null)) {
    const n = Number(game.usdPrice ?? game.currentPrice);
    return esc(`US$ ${n.toFixed(2)}`);
  }
  if (game.priceLabel) return esc(game.priceLabel);
  if (game.currentPrice != null) return esc(formatBRL(game.currentPrice));
  return "—";
}

function dealRow(game) {
  const img = cover(game);
  const thumb = img
    ? `<img src="${esc(img)}" alt="">`
    : `<div class="gwd-deal-ph"></div>`;
  const href = game.ggDealsUrl || "#";
  const meta = [game.store || game.source || "gg.deals", game.relativeTime].filter(Boolean).join(" · ");
  const hl = game.historicalLow ? `<span class="gwd-hl" title="Historical low">HL</span>` : "";
  return `<a class="gwd-deal" href="${esc(href)}">
    ${thumb}
    <div class="gwd-deal-main">
      <div class="gwd-deal-name">${check(game.owned)}${esc(game.name)}</div>
      <div class="gwd-deal-src">${esc(meta)}</div>
    </div>
    <div class="gwd-deal-right">${discTag(game.discount)}${hl}<div class="gwd-deal-price">${dealPrice(game)}</div></div>
  </a>`;
}

function updateCard(event) {
  const img = event.headerImage
    ? `<img src="${esc(event.headerImage)}" alt="">`
    : `<div class="gwd-upd-ph"></div>`;
  const price =
    event.isFree || event.price === 0
      ? `<span class="gwd-upd-price">Free</span>`
      : event.price != null
        ? `<span class="gwd-upd-price">${esc(formatBRL(event.price))}</span>`
        : "";
  const steam = event.steamUpdate
    ? `<div class="gwd-upd-steam">teve atualização na Steam</div>`
    : "";
  return `<a class="gwd-upd" href="${esc(event.storeUrl || "#")}">
    <div class="gwd-upd-art">${img}</div>
    <div class="gwd-upd-body">
      <div class="gwd-upd-name">${esc(event.name)}</div>
      <div class="gwd-upd-text">${esc(event.text)}</div>
      ${steam}
      ${price}
    </div>
  </a>`;
}

function updatesBanner(events) {
  const list = (events || []).slice(0, 5);
  if (!list.length) {
    return `<div class="gwd-updates gwd-updates-quiet">Nenhuma atualização recente na wishlist.</div>`;
  }
  return `<div class="gwd-updates">
    <div class="gwd-updates-head">Atualizações da wishlist</div>
    <div class="gwd-updates-row">${list.map(updateCard).join("")}</div>
  </div>`;
}

function renderDashboard(games, extra = {}) {
  const {
    timezone,
    updatedAt,
    mostWanted = [],
    ggPopular = [],
    ownedPrivate = false,
    storeHub = { events: [], specials: [], newDeals: [], bestDeals: [] },
    ggDeals = {},
    wishlistUpdates = [],
  } = extra;

  const wishAll = [...games].filter((game) => game.onWishlist !== false);
  const coming = wishAll.filter(isUnreleased).sort((a, b) => String(a.name).localeCompare(String(b.name), "pt"));
  const onSale = wishAll
    .filter((game) => !isUnreleased(game) && Number(game.discount) > 0)
    .sort((a, b) => {
      const dd = Number(b.discount || 0) - Number(a.discount || 0);
      if (dd) return dd;
      return Number(a.currentPrice ?? Infinity) - Number(b.currentPrice ?? Infinity);
    });
  const fullPrice = wishAll
    .filter((game) => !isUnreleased(game) && !Number(game.discount))
    .sort((a, b) => Number(a.currentPrice ?? Infinity) - Number(b.currentPrice ?? Infinity));

  const comingCards = coming.map((game, i) => gameCard(game, { rank: i + 1, href: game.storeUrl, soon: true })).join("");
  const saleCards = onSale.map((game, i) => gameCard(game, { rank: i + 1, href: game.storeUrl })).join("");
  const fullCards = fullPrice.map((game, i) => gameCard(game, { rank: i + 1, href: game.storeUrl })).join("");

  const popularCards = (mostWanted || []).map((game) =>
    gameCard(game, { rank: game.rank, href: game.storeUrl })
  ).join("");

  const ggCards = (ggPopular || []).map((game) => ggCard(game)).join("");

  const dealCards = (storeHub.dealsStrip || []).length
    ? storeHub.dealsStrip
        .map((item) => {
          if (item.kind === "event") return eventBanner(item);
          return gameCard(item, { rank: null, href: item.storeUrl });
        })
        .join("")
    : (storeHub.events || []).map(eventBanner).join("") ||
      (storeHub.specials || [])
        .map((item) => gameCard(item, { href: item.storeUrl }))
        .join("");

  const dealLists = resolveDealLists(ggDeals, storeHub);
  const newDeals =
    (dealLists.newDeals || []).map(dealRow).join("") ||
    `<div class="gwd-empty">Sem ofertas novas no gg.deals agora.</div>`;
  const bestDeals =
    (dealLists.bestDeals || []).map(dealRow).join("") ||
    `<div class="gwd-empty">Sem best deals no gg.deals agora.</div>`;
  const ggLink = { href: "https://gg.deals/", label: "Ver no gg.deals" };
  const usdNote = storeHub.ggDealsUsd
    ? `<div class="gwd-empty">Preços como no gg.deals (muitos em USD). A ordem das listas é a do site.</div>`
    : "";

  const ownedHint = ownedPrivate
    ? "Biblioteca privada: o ✓ só aparece se Detalhes dos jogos estiver público."
    : "✓ = já comprado";

  return `---
cssclasses:
  - game-wishlist-dashboard
tags:
  - dashboard
  - steam
---

<div class="gwd-root">
  ${updatesBanner(wishlistUpdates)}
  <div class="gwd-top" title="${esc(`Atualizar abre uma janela do Windows. Depois volte aqui e pressione Ctrl+R. Protocolo steamwish. ${ownedHint}`)}">
    <div class="gwd-title">🎮 Minha Wishlist Steam</div>
    <div class="gwd-actions">
      <span class="gwd-pill">${esc(badgeText(updatedAt, timezone))}</span>
      <a class="gwd-nav" href="obsidian://open?file=Backlog%20Steam">Backlog</a>
      <a class="gwd-nav" href="obsidian://open?file=N%C3%A3o%20vou%20jogar">Não vou jogar</a>
      <a class="gwd-update" href="steamwish://update" title="Depois volte aqui e pressione Ctrl+R">Atualizar</a>
    </div>
  </div>
  <div class="gwd-hint">${wishAll.length} jogos · ${coming.length} em breve · ${onSale.length} em promo · ${fullPrice.length} preço cheio</div>

  <div class="gwd-wish-strips">
    ${wishStrip("Ainda não lançou", `${coming.length} jogos · sem preço de verdade`, comingCards)}
    ${wishStrip("Em promoção", `${onSale.length} jogos · maior desconto na frente`, saleCards)}
    ${wishStrip("Preço normal", `${fullPrice.length} jogos · menor preço na frente`, fullCards)}
  </div>

  ${sectionHead("Mais desejados na Steam", "ranking público da loja · inclui os que você já tem")}
  ${scrollRow(popularCards)}

  ${sectionHead("Most Popular Games", "gg.deals · capas da página da Steam")}
  ${scrollRow(ggCards)}

  ${sectionHead("Descontos e eventos da Steam", "promoções do dia · role para o lado")}
  ${scrollRow(dealCards)}

  <div class="gwd-deals-cols">
    <div class="gwd-deals-col">
      ${sectionHead("New deals", "gg.deals · New deals", ggLink)}
      ${newDeals}
    </div>
    <div class="gwd-deals-col">
      ${sectionHead("Best deals", "gg.deals · Best deals", ggLink)}
      ${bestDeals}
    </div>
  </div>
  ${usdNote}
</div>
`;
}

async function writeDashboard(games, config, extra = {}) {
  const fromFile = await readJson(config.paths.ggDeals, { newDeals: [], bestDeals: [] });
  const storeHub = extra.storeHub || { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] };
  const ggDeals = resolveDealLists(extra.ggDeals || storeHub, fromFile);
  const markdown = renderDashboard(games, {
    timezone: config.timezone,
    updatedAt: extra.updatedAt || games[0]?.updatedAt || new Date().toISOString(),
    mostWanted: extra.mostWanted || [],
    ggPopular: extra.ggPopular || [],
    ownedPrivate: Boolean(extra.ownedPrivate),
    storeHub,
    ggDeals,
    wishlistUpdates: extra.wishlistUpdates || [],
  });
  const files = [
    path.join(config.paths.root, "Minha Wishlist Steam.md"),
    config.paths.dashboardNote,
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, markdown, "utf8");
  }
}

module.exports = {
  writeDashboard,
  renderDashboard,
};
