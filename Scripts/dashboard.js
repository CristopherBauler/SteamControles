/**
 * Painel visual: faixas horizontais com rolagem nativa.
 * CSS extra em .obsidian/snippets/game-wishlist-dashboard.css
 */

const fs = require("fs/promises");
const path = require("path");
const { formatBRL } = require("./config");

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

function priceLine(game) {
  const status = listTone(game);
  const color = PRICE_COLOR[status] || PRICE_COLOR.igual;
  const price =
    game.currentPrice === 0
      ? `<span style="color:#3dd68c;font-weight:700">Free</span>`
      : `<span style="color:${color};font-weight:700">${esc(formatBRL(game.currentPrice))}</span>`;
  return `${price} ${discTag(game.discount)}`;
}

function sectionHead(title, extra = "") {
  return `<div class="gwd-sechead">
    <div class="gwd-sectitle">${esc(title)}</div>
    <div class="gwd-secextra">${esc(extra)}</div>
  </div>`;
}

function wishHead(active) {
  const priceOn = active === "preco" ? " is-on" : "";
  const discOn = active === "desconto" ? " is-on" : "";
  return `<div class="gwd-sechead">
    <div class="gwd-sectitle">Minha lista de desejos</div>
    <div class="gwd-sort">
      <a class="gwd-sort-btn${priceOn}" href="#gwd-wish-price">Preço</a>
      <a class="gwd-sort-btn${discOn}" href="#gwd-wish-disc">Desconto</a>
    </div>
  </div>`;
}

function scrollRow(cardsHtml) {
  if (!cardsHtml) return `<div class="gwd-empty">Nada para mostrar agora.</div>`;
  return `<div class="gwd-scroller"><div class="gwd-track">${cardsHtml}</div></div>`;
}

function gameCard(game, { rank, href } = {}) {
  const img = cover(game);
  if (!img) return "";
  const link = href || game.storeUrl || "#";
  return `<a class="gwd-card" href="${esc(link)}">
    <div class="gwd-card-art">
      <img src="${esc(img)}" alt="">
      ${rank != null ? `<span class="gwd-rank">#${rank}</span>` : ""}
    </div>
    <div class="gwd-card-name">${check(game.owned)}${esc(game.name)}</div>
    <div class="gwd-card-price">${priceLine(game)}</div>
  </a>`;
}

function ggCard(game) {
  const img = cover(game);
  if (!img) return "";
  const link = game.storeUrl || game.ggDealsUrl || "#";
  const price =
    game.currentPrice === 0
      ? `<span class="gwd-from-free">Free</span>`
      : game.currentPrice != null
        ? `<span class="gwd-from-val" style="color:${PRICE_COLOR[listTone(game)]}">${esc(formatBRL(game.currentPrice))}</span>`
        : `<span class="gwd-from-val">—</span>`;
  return `<a class="gwd-gg" href="${esc(link)}">
    <div class="gwd-gg-art">
      <img src="${esc(img)}" alt="">
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

function dealRow(game) {
  const img = cover(game);
  if (!img) return "";
  const price =
    game.currentPrice === 0
      ? `<span style="color:#3dd68c;font-weight:700">Free</span>`
      : esc(formatBRL(game.currentPrice));
  return `<a class="gwd-deal" href="${esc(game.storeUrl)}">
    <img src="${esc(img)}" alt="">
    <div class="gwd-deal-main">
      <div class="gwd-deal-name">${check(game.owned)}${esc(game.name)}</div>
      <div class="gwd-deal-src">${esc(game.source || "Steam")}</div>
    </div>
    <div class="gwd-deal-right">${discTag(game.discount)}<div class="gwd-deal-price">${price}</div></div>
  </a>`;
}

function renderDashboard(games, extra = {}) {
  const {
    timezone,
    updatedAt,
    mostWanted = [],
    ggPopular = [],
    ownedPrivate = false,
    storeHub = { events: [], specials: [], newDeals: [], bestDeals: [] },
  } = extra;

  const byPrice = [...games]
    .filter((game) => game.onWishlist !== false)
    .sort((a, b) => {
      const av = a.currentPrice == null ? Number.POSITIVE_INFINITY : Number(a.currentPrice);
      const bv = b.currentPrice == null ? Number.POSITIVE_INFINITY : Number(b.currentPrice);
      return av - bv;
    });

  const byDiscount = [...games]
    .filter((game) => game.onWishlist !== false)
    .sort((a, b) => {
      const dd = Number(b.discount || 0) - Number(a.discount || 0);
      if (dd) return dd;
      const av = a.currentPrice == null ? Number.POSITIVE_INFINITY : Number(a.currentPrice);
      const bv = b.currentPrice == null ? Number.POSITIVE_INFINITY : Number(b.currentPrice);
      return av - bv;
    });

  const wishPriceCards = byPrice.map((game, i) => gameCard(game, { rank: i + 1, href: game.storeUrl })).join("");
  const wishDiscCards = byDiscount.map((game, i) => gameCard(game, { rank: i + 1, href: game.storeUrl })).join("");

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

  const newDeals =
    (storeHub.newDeals || []).map(dealRow).join("") ||
    `<div class="gwd-empty">Sem ofertas novas agora.</div>`;
  const bestDeals =
    (storeHub.bestDeals || []).map(dealRow).join("") ||
    `<div class="gwd-empty">Sem best deals agora.</div>`;

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
  <div class="gwd-top">
    <div class="gwd-title">🎮 Minha Wishlist Steam</div>
    <div class="gwd-actions">
      <span class="gwd-pill">${esc(badgeText(updatedAt, timezone))}</span>
      <a class="gwd-update" href="steamwish://update">Atualizar</a>
    </div>
  </div>
  <div class="gwd-hint">${byPrice.length} jogos · verde promoção · azul preço normal · vermelho aumentou do valor gravado · ${ownedHint}<br>Atualizar abre uma janela do Windows. Depois volte aqui e pressione Ctrl+R. Se o Windows perguntar, permita o atalho steamwish.</div>

  <div class="gwd-wish-block" id="gwd-wish-price">
    ${wishHead("preco")}
    ${scrollRow(wishPriceCards)}
  </div>
  <div class="gwd-wish-block" id="gwd-wish-disc">
    ${wishHead("desconto")}
    ${scrollRow(wishDiscCards)}
  </div>

  ${sectionHead("Mais desejados na Steam", "ranking público da loja · inclui os que você já tem")}
  ${scrollRow(popularCards)}

  ${sectionHead("Most Popular Games", "gg.deals · capas da página da Steam")}
  ${scrollRow(ggCards)}

  ${sectionHead("Descontos e eventos da Steam", "promoções do dia · role para o lado")}
  ${scrollRow(dealCards)}

  ${sectionHead("New deals", "ofertas novas da Steam")}
  ${newDeals}

  ${sectionHead("Best deals", "maior desconto agora")}
  ${bestDeals}
</div>
`;
}

async function writeDashboard(games, config, extra = {}) {
  const markdown = renderDashboard(games, {
    timezone: config.timezone,
    updatedAt: extra.updatedAt || games[0]?.updatedAt || new Date().toISOString(),
    mostWanted: extra.mostWanted || [],
    ggPopular: extra.ggPopular || [],
    ownedPrivate: Boolean(extra.ownedPrivate),
    storeHub: extra.storeHub || { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] },
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
