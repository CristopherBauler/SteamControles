/**
 * Painel visual: faixas horizontais com rolagem nativa.
 * CSS extra em .obsidian/snippets/game-wishlist-dashboard.css
 */

const fs = require("fs/promises");
const path = require("path");
const { formatBRL, readJson } = require("./config");
const { resolveDealLists } = require("./ggDeals");
const { capsuleUrl } = require("./steamApi");

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
  const raw = String(game?.headerImage || game?.image || "");
  if (raw && !/img\.gg\.deals/i.test(raw)) return raw;
  const id = Number(game?.appId);
  if (Number.isInteger(id) && id > 0) return capsuleUrl(id);
  return "";
}

function dealThumb(game) {
  const img = cover(game);
  const id = Number(game?.appId);
  const fallback =
    Number.isInteger(id) && id > 0
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`
      : "";
  if (!img && !fallback) return `<div class="gwd-deal-ph"></div>`;
  const src = img || fallback;
  const next = src === fallback ? "" : fallback;
  const err = next
    ? ` data-fallback="${esc(next)}" onerror="dealCoverError(this)"`
    : ` onerror="dealCoverError(this)"`;
  return `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer"${err}>`;
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

function isTbaReleaseDate(date) {
  const text = String(date || "").trim();
  if (!text) return false;
  return /to be announced|a ser anunciad|em breve|^tba$|coming soon|quando estiver/i.test(text);
}

function storeAmount(game) {
  if (game?.currentPrice != null && game.currentPrice !== "") {
    const n = Number(game.currentPrice);
    if (Number.isFinite(n)) return n;
  }
  const label = String(game?.priceLabel || "").trim();
  if (!label || label === "—") return null;
  if (/^free$/i.test(label)) return 0;
  if (/^em breve$/i.test(label) || /^tba$/i.test(label)) return null;
  const brl = label.match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/);
  if (brl) {
    const n = Number(`${brl[1].replace(/\./g, "")}.${brl[2]}`);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isUnreleased(game) {
  const amount = storeAmount(game);
  if (amount != null && amount > 0) return false;
  if (game?.comingSoon === false) {
    if (amount == null) return true;
    return false;
  }
  if (isTbaReleaseDate(game?.releaseDate)) return true;
  if (game?.comingSoon === true) return true;
  return amount == null || amount === 0;
}

function byNamePt(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""), "pt", { sensitivity: "base" });
}

function byPriceAsc(a, b) {
  const pa = Number(a.currentPrice ?? Infinity);
  const pb = Number(b.currentPrice ?? Infinity);
  if (pa !== pb) return pa - pb;
  return Number(b.discount || 0) - Number(a.discount || 0);
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
  return `<div class="gwd-wish-block">
    ${sectionHead(title, extra)}
    <input type="search" class="gwd-name-q" placeholder="Buscar pelo nome" autocomplete="off" spellcheck="false">
    ${scrollRow(cardsHtml)}
  </div>`;
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
  const key = String(game.name || "").toLowerCase();
  return `<a class="gwd-card" href="${esc(link)}" data-name="${esc(key)}">
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
  const href = game.ggDealsUrl || "#";
  const meta = [game.store || game.source || "gg.deals", game.relativeTime].filter(Boolean).join(" · ");
  const hl = game.historicalLow ? `<span class="gwd-hl" title="Historical low">HL</span>` : "";
  return `<a class="gwd-deal" href="${esc(href)}">
    ${dealThumb(game)}
    <div class="gwd-deal-main">
      <div class="gwd-deal-name">${check(game.owned)}${esc(game.name)}</div>
      <div class="gwd-deal-src">${esc(meta)}</div>
    </div>
    <div class="gwd-deal-right">${discTag(game.discount)}${hl}<div class="gwd-deal-price">${dealPrice(game)}</div></div>
  </a>`;
}

function formatUpdWhen(iso, timezone) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(+date)) return "";
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, day: "numeric" }).format(date);
  const month = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, month: "long" }).format(date);
  return `${day} DE ${month}`.toUpperCase();
}

function formatUpdDay(iso, timezone) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(+date)) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
  })
    .format(date)
    .replace(".", "")
    .toUpperCase();
}

const UPD_KIND_LABEL = {
  launch: "Lançamento",
  earlyAccess: "Saiu do acesso antecipado",
  dlc: "DLC",
  majorUpdate: "Grande atualização",
  update: "Atualização",
  smallUpdate: "Pequena atualização",
  content: "Conteúdo",
  news: "Notícias",
  sale: "Promoção",
  saleOff: "Saiu de promoção",
  price: "Preço",
};

const UPD_PATCH_KINDS = new Set(["launch", "earlyAccess", "dlc", "majorUpdate", "update", "smallUpdate", "content"]);
const UPD_NEWS_KINDS = new Set(["news"]);
const UPD_PROMO_KINDS = new Set(["sale", "saleOff", "price"]);

function updateCard(event, timezone) {
  const img = event.headerImage
    ? `<img src="${esc(event.headerImage)}" alt="">`
    : `<div class="gwd-upd-ph${event.kind === "smallUpdate" ? " gwd-upd-ph-patch" : ""}"></div>`;
  const kind = UPD_KIND_LABEL[event.kind] || "Atualização";
  const when = formatUpdWhen(event.at, timezone || event.timezone);
  const flag = event.featured ? `<div class="gwd-upd-flag">Destaque</div>` : "";
  const gameName = event.name || "";
  return `<a class="gwd-upd gwd-upd-${esc(event.kind || "news")}${event.featured ? " gwd-upd-feature" : ""}" href="${esc(event.storeUrl || "#")}">
    ${flag}
    <div class="gwd-upd-inner">
      <div class="gwd-upd-art">${img}${gameName ? `<div class="gwd-upd-gametag">${esc(gameName)}</div>` : ""}</div>
      <div class="gwd-upd-body">
        ${gameName ? `<div class="gwd-upd-gamepill">${esc(gameName)}</div>` : ""}
        <div class="gwd-upd-kicker">${esc(kind.toUpperCase())}${when ? ` · ${esc(when)}` : ""}</div>
        <div class="gwd-upd-name">${esc(event.title || event.name)}</div>
        ${event.text ? `<div class="gwd-upd-text">${esc(event.text)}</div>` : ""}
      </div>
    </div>
  </a>`;
}

function updatesColumn(title, events, timezone, empty, tileId) {
  const id = tileId ? ` data-board-tile="${esc(tileId)}"` : "";
  if (!events.length) {
    return `<div class="gwd-updates-col board-tile"${id}>
      <div class="gwd-updates-col-head">${esc(title)}</div>
      <div class="gwd-updates-quiet">${esc(empty)}</div>
    </div>`;
  }
  return `<div class="gwd-updates-col board-tile"${id}>
    <div class="gwd-updates-col-head">${esc(title)} <span>${events.length}</span></div>
    <div class="gwd-upd-day-list">${events.map((event) => updateCard(event, timezone)).join("")}</div>
  </div>`;
}

function updatesBanner(events, timezone) {
  const list = events || [];
  const patches = list.filter((event) => UPD_PATCH_KINDS.has(event.kind)).slice(0, 8);
  const news = list.filter((event) => UPD_NEWS_KINDS.has(event.kind)).slice(0, 8);
  const promos = list.filter((event) => UPD_PROMO_KINDS.has(event.kind)).slice(0, 6);
  if (!patches.length && !news.length && !promos.length) {
    return `<div class="gwd-updates gwd-updates-quiet">Nenhuma atualização na wishlist nos últimos 7 dias.</div>`;
  }
  return `<div class="gwd-updates" data-board="novidades">
    <div class="gwd-updates-head">Novidades da wishlist</div>
    <div class="gwd-updates-hint">últimos 7 dias · arraste as seções e mude o tamanho</div>
    ${updatesColumn("Atualizações", patches, timezone, "Nenhum patch ou lançamento nesta semana.", "patches")}
    ${updatesColumn("Notícias", news, timezone, "Nenhuma notícia nesta semana.", "news")}
    ${
      promos.length
        ? `<div class="gwd-updates-promo board-tile" data-board-tile="promos">
      <div class="gwd-updates-col-head">Promoções <span>${promos.length}</span></div>
      <div class="gwd-upd-day-list">${promos.map((event) => updateCard(event, timezone)).join("")}</div>
    </div>`
        : `<div class="gwd-updates-promo board-tile" data-board-tile="promos">
      <div class="gwd-updates-col-head">Promoções</div>
      <div class="gwd-updates-quiet">Nenhuma promoção nesta semana.</div>
    </div>`
    }
  </div>`;
}

function wishSearchBlock() {
  return [
    "```dataviewjs",
    "for (const input of document.querySelectorAll('.gwd-name-q')) {",
    "  if (input.dataset.gwdBound) continue;",
    "  input.dataset.gwdBound = '1';",
    "  input.addEventListener('input', () => {",
    "    const q = String(input.value || '').trim().toLowerCase();",
    "    const block = input.closest('.gwd-wish-block');",
    "    if (!block) return;",
    "    for (const card of block.querySelectorAll('.gwd-card')) {",
    "      const name = String(card.getAttribute('data-name') || card.textContent || '').toLowerCase();",
    "      card.style.display = !q || name.includes(q) ? '' : 'none';",
    "    }",
    "  });",
    "}",
    "```",
  ].join("\n");
}

function storePageHtml({
  mostWanted = [],
  ggPopular = [],
  storeHub = { events: [], specials: [], newDeals: [], bestDeals: [], dealsStrip: [] },
  ggDeals = {},
} = {}) {
  const popularCards = (mostWanted || [])
    .map((game) => gameCard(game, { rank: game.rank, href: game.storeUrl }))
    .join("");
  const ggCards = (ggPopular || []).map((game) => ggCard(game)).join("");
  const dealCards = (storeHub.dealsStrip || []).length
    ? storeHub.dealsStrip
        .map((item) => {
          if (item.kind === "event") return eventBanner(item);
          return gameCard(item, { rank: null, href: item.storeUrl });
        })
        .join("")
    : (storeHub.events || []).map(eventBanner).join("") ||
      (storeHub.specials || []).map((item) => gameCard(item, { href: item.storeUrl })).join("");
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
  const stale =
    ggDeals.scraped === false || storeHub.ggDealsScraped === false
      ? `<div class="gwd-empty">gg.deals bloqueou a leitura agora — mostrando o último ranking que entrou. A Loja tenta de novo sozinha a cada 30 min.</div>`
      : "";
  return `<div class="gwd-store" data-board="loja">
    <div class="board-tile" data-board-tile="wanted">
      ${sectionHead("Mais desejados na Steam", "ranking público da loja · inclui os que você já tem")}
      ${scrollRow(popularCards)}
    </div>
    <div class="board-tile" data-board-tile="popular">
      ${sectionHead("Most Popular Games", "gg.deals · capas da página da Steam")}
      ${scrollRow(ggCards)}
    </div>
    <div class="board-tile" data-board-tile="steam">
      ${sectionHead("Descontos e eventos da Steam", "promoções do dia · role para o lado")}
      ${scrollRow(dealCards)}
    </div>
    <div class="board-tile" data-board-tile="newdeals">
      ${sectionHead("New deals", "gg.deals · New deals", ggLink)}
      ${newDeals}
    </div>
    <div class="board-tile" data-board-tile="bestdeals">
      ${sectionHead("Best deals", "gg.deals · Best deals", ggLink)}
      ${bestDeals}
    </div>
    ${usdNote}
    ${stale}
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
  const coming = wishAll.filter(isUnreleased).sort(byNamePt);
  const onSale = wishAll
    .filter((game) => !isUnreleased(game) && Number(game.discount) > 0)
    .sort(byPriceAsc);
  const fullPrice = wishAll
    .filter((game) => !isUnreleased(game) && !Number(game.discount))
    .sort(byPriceAsc);

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
  ${updatesBanner(wishlistUpdates, timezone)}
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
    ${wishStrip("Em promoção", `${onSale.length} jogos · menor preço na frente`, saleCards)}
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

${wishSearchBlock()}
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
  isUnreleased,
  updatesBanner,
  storePageHtml,
};
