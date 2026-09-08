const $ = (id) => document.getElementById(id);

const TABS = ["novidades", "wishlist", "loja", "jogos", "backlog"];
const DEFAULT_THEME = {
  general: "#12161d",
  button: "#2563eb",
  tabs: {
    novidades: "#2563eb",
    wishlist: "#2563eb",
    loja: "#2563eb",
    jogos: "#2563eb",
    backlog: "#2563eb",
  },
};
let activeTab = "novidades";
let wishFilter = "all";
let wishGames = [];
let libraryGames = [];
let skippedGames = [];
let libraryMeta = {};
let epicSession = { loggedIn: false, name: "", count: 0, source: "", error: "" };
let libraryBusy = false;
let syncUiLocks = 0;
let lastUiState = null;
const BACKLOG_SORTS = ["hours", "reviews", "name", "recent"];
const BACKLOG_SORT_KEY = "mld.backlogSort";
let backlogSort = "hours";
let savedTheme = { ...DEFAULT_THEME, tabs: { ...DEFAULT_THEME.tabs } };
let themeDirty = false;
let libraryPaintDirty = true;
let skippedPaintDirty = true;
let jogosSearchTimer = 0;
let backlogSearchTimer = 0;

function hexToRgb(hex) {
  const raw = String(hex || "").replace("#", "").trim();
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function mixHex(a, b, t) {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  if (!left || !right) return a;
  return rgbToHex(
    left.r + (right.r - left.r) * t,
    left.g + (right.g - left.g) * t,
    left.b + (right.b - left.b) * t
  );
}

function luma(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

function contrastText(hex) {
  return luma(hex) > 0.55 ? "#12161d" : "#f4f7fb";
}

function normalizeTheme(theme) {
  const src = theme && typeof theme === "object" ? theme : {};
  const tabs = src.tabs && typeof src.tabs === "object" ? src.tabs : {};
  const clean = (value, fallback) => {
    const rgb = hexToRgb(value);
    return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : fallback;
  };
  return {
    general: clean(src.general, DEFAULT_THEME.general),
    button: clean(src.button, DEFAULT_THEME.button),
    tabs: Object.fromEntries(TABS.map((id) => [id, clean(tabs[id], DEFAULT_THEME.tabs[id])])),
  };
}

function applyTheme(theme) {
  const next = normalizeTheme(theme);
  const bg = next.general;
  const dark = luma(bg) < 0.55;
  const white = "#ffffff";
  const black = "#000000";
  const toward = dark ? white : black;
  const root = document.documentElement;
  root.style.setProperty("--bg", bg);
  root.style.setProperty("--surface", mixHex(bg, toward, dark ? 0.08 : 0.07));
  root.style.setProperty("--surface-2", mixHex(bg, toward, dark ? 0.16 : 0.14));
  root.style.setProperty("--border", mixHex(bg, toward, dark ? 0.2 : 0.22));
  root.style.setProperty("--text", contrastText(bg));
  root.style.setProperty("--muted", mixHex(contrastText(bg), bg, 0.42));
  root.style.setProperty("--btn", next.button);
  root.style.setProperty("--btn-text", contrastText(next.button));
  root.style.setProperty("--btn-hover", mixHex(next.button, contrastText(next.button) === "#f4f7fb" ? white : black, 0.14));
  TABS.forEach((id) => root.style.setProperty(`--tab-${id}`, next.tabs[id]));
  document.body.style.colorScheme = dark ? "dark" : "light";
}

function readThemeFromInputs() {
  return {
    general: $("colorGeneral").value,
    button: $("colorButton").value,
    tabs: Object.fromEntries(TABS.map((id) => [id, $(`colorTab-${id}`).value])),
  };
}

function fillThemeInputs(theme) {
  const next = normalizeTheme(theme);
  $("colorGeneral").value = next.general;
  $("colorButton").value = next.button;
  TABS.forEach((id) => {
    $(`colorTab-${id}`).value = next.tabs[id];
  });
}

function previewThemeFromInputs() {
  themeDirty = true;
  applyTheme(readThemeFromInputs());
}

function when(iso) {
  if (!iso) return "ainda não sincronizou";
  const date = new Date(iso);
  return date.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function formatSyncStatus(payload) {
  if (!payload?.syncing) {
    if (document.body.classList.contains("capacitor")) {
      if (payload?.paired && payload?.seededFromPc) {
        return `Celular · último ${when(payload?.lastSyncAt)} · marcas com o PC no Wi‑Fi`;
      }
      if (payload?.paired) {
        return `Primeiro espelho do PC…`;
      }
      return `Último sync: ${when(payload?.lastSyncAt)} · toque em Atualizar agora`;
    }
    const storeBit = payload?.lastStoreAt ? ` · Loja ${when(payload.lastStoreAt)}` : "";
    return `Wishlist: ${when(payload?.lastSyncAt)}${storeBit} · próximo ${when(payload?.nextSyncAt)}`;
  }
  const raw = payload.syncPercent ?? payload.percent;
  const n = Number(raw);
  const shown = Number.isFinite(n) ? Math.max(0, Math.min(99, Math.round(n))) : 0;
  const label = String(payload.syncLabel ?? payload.label ?? "").trim();
  return label ? `Sincronizando… ${shown}% · ${label}` : `Sincronizando… ${shown}%`;
}

function normalizeQuery(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(name, query) {
  if (!query) return true;
  return normalizeQuery(name).includes(query);
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

function buckets(games) {
  const all = games || [];
  return {
    all,
    sale: all.filter((game) => !isUnreleased(game) && Number(game.discount) > 0),
    soon: all.filter((game) => isUnreleased(game)),
    full: all.filter((game) => !isUnreleased(game) && !Number(game.discount)),
    ea: all.filter((game) => game.earlyAccess),
  };
}

function sortGames(key, list) {
  const arr = [...list];
  if (key === "sale" || key === "full") {
    arr.sort(byPriceAsc);
    return arr;
  }
  if (key === "soon") {
    arr.sort(byNamePt);
    return arr;
  }
  if (key === "ea") {
    const soon = arr.filter((game) => isUnreleased(game));
    const priced = arr.filter((game) => !isUnreleased(game));
    return [...sortGames("soon", soon), ...priced.sort(byPriceAsc)];
  }
  const grouped = buckets(arr);
  return [...sortGames("soon", grouped.soon), ...[...grouped.sale, ...grouped.full].sort(byPriceAsc)];
}

function priceText(game) {
  if (isUnreleased(game)) return "Em breve";
  if (Number(game.discount) > 0) return `-${game.discount}% · ${game.priceLabel || ""}`;
  if (game.currentPrice === 0 || game.isFree) return "Free";
  return game.priceLabel || "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showTab(tab) {
  activeTab = TABS.includes(tab) ? tab : "novidades";
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.dataset.tab === activeTab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  TABS.forEach((id) => {
    const panel = $(`tab-${id}`);
    if (panel) panel.classList.toggle("hidden", id !== activeTab);
  });
  if (activeTab === "jogos" && libraryPaintDirty) paintLibrary();
  if (activeTab === "backlog" && skippedPaintDirty) paintSkipped();
}

function setWishFilter(filter) {
  wishFilter = ["all", "sale", "soon", "full", "ea"].includes(filter) ? filter : "all";
  document.querySelectorAll("#wishStats .stat").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.filter === wishFilter);
  });
  paintGames();
}

function paintGames() {
  const grouped = buckets(wishGames);
  const source = grouped[wishFilter] || grouped.all;
  const query = normalizeQuery($("search")?.value);
  const list = sortGames(wishFilter, source).filter((game) => nameMatches(game.name, query));
  const labels = {
    all: "não lançados na frente · depois menor preço",
    sale: "em promoção · menor preço na frente",
    soon: "ainda não lançou · A–Z",
    full: "preço normal · menor preço na frente",
    ea: "acesso antecipado · não lançados na frente, depois menor preço",
  };
  $("wishHint").textContent = query
    ? `${list.length} resultado(s) em ${labels[wishFilter]}`
    : `${list.length} jogos · ${labels[wishFilter]}`;
  $("games").innerHTML =
    list
      .map((game) => {
        const img = game.headerImage ? `<img src="${esc(game.headerImage)}" alt="">` : `<div class="ph"></div>`;
        const badge = game.earlyAccess ? `<span class="ea-badge">EA</span>` : "";
        return `<a class="game" href="${esc(game.storeUrl || "#")}">${img}<span>${esc(game.name || "")}</span><em>${esc(priceText(game))}${badge}</em></a>`;
      })
      .join("") || `<div class="empty-games">Nenhum jogo neste filtro.</div>`;
}

const HOUR_SHELVES = [
  { key: "h100", tone: "green", title: "Mais de 100 h", extra: "os que mais te consumiram", test: (h, game) => game?.store !== "epic" && h >= 100 },
  { key: "h50", tone: "green", title: "50 a 100 h", extra: "já virou hábito", test: (h, game) => game?.store !== "epic" && h >= 50 && h < 100 },
  { key: "h20", tone: "green", title: "20 a 50 h", extra: "bem avançados", test: (h, game) => game?.store !== "epic" && h >= 20 && h < 50 },
  { key: "h10", tone: "green", title: "10 a 20 h", extra: "em andamento", test: (h, game) => game?.store !== "epic" && h >= 10 && h < 20 },
  { key: "h1", tone: "red", title: "Menos de 10 h", extra: "só comecei", test: (h, game) => game?.store !== "epic" && h > 0 && h < 10 },
  { key: "epic", tone: "blue", title: "Epic Games", extra: "biblioteca da conta (entre na Epic se faltar jogo)", test: (_h, game) => game?.store === "epic" },
  { key: "never", tone: "red", title: "Nunca jogado", extra: "zero horas neste PC", test: (h, game) => game?.store !== "epic" && h <= 0 },
];

function libHours(game) {
  return Number(game?.hours) || 0;
}

function formatLibHours(hours) {
  if (!hours || hours <= 0) return { text: "Nunca jogado", never: true };
  const rounded = Math.round(hours * 10) / 10;
  return {
    text: `${rounded.toLocaleString("pt-BR", {
      minimumFractionDigits: rounded % 1 ? 1 : 0,
      maximumFractionDigits: 1,
    })} h`,
    never: false,
  };
}

function formatHoursPlain(hours) {
  const n = Math.max(0, Number(hours) || 0);
  const rounded = Math.round(n * 10) / 10;
  return `${rounded.toLocaleString("pt-BR", {
    minimumFractionDigits: rounded % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  })} h`;
}

function groupByHours(games) {
  return HOUR_SHELVES.map((def) => {
    const items = games.filter((game) => def.test(libHours(game), game));
    const hours = items.reduce((sum, game) => sum + libHours(game), 0);
    return { ...def, items, hours };
  }).filter((shelf) => shelf.items.length);
}

function shrinkEpicCoverUrl(url) {
  const src = String(url || "").trim();
  if (!src || !/^https?:\/\//i.test(src)) return src;
  try {
    const parsed = new URL(src);
    if (!/(?:^|\.)(?:epicgames|unrealengine)\.com$/i.test(parsed.hostname)) return src;
    const currentW = Number(parsed.searchParams.get("w")) || 0;
    const currentH = Number(parsed.searchParams.get("h")) || 0;
    const resized = parsed.searchParams.get("resize") === "1";
    if (resized && currentW > 0 && currentW <= 480 && (currentH === 0 || currentH <= 180)) return src;
    parsed.searchParams.set("resize", "1");
    parsed.searchParams.set("w", "480");
    parsed.searchParams.set("h", "180");
    return parsed.toString();
  } catch {
    return src;
  }
}

function isEpicCoverUrl(url) {
  try {
    return /(?:^|\.)(?:epicgames|unrealengine)\.com$/i.test(new URL(String(url || "")).hostname);
  } catch {
    return false;
  }
}

function libCoverList(game) {
  const id = Number(game.appId);
  const list = [];
  const push = (url) => {
    const src = shrinkEpicCoverUrl(url);
    if (!src || /library_hero/i.test(src) || list.includes(src) || list.length >= 2) return;
    list.push(src);
  };
  push(game.cover);
  if (Array.isArray(game.covers)) game.covers.forEach(push);
  if (game.store !== "epic" && Number.isInteger(id) && id > 0 && id < 2100000000) {
    push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_231x87.jpg`);
    push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`);
  }
  return list;
}

function dealCoverError(img) {
  const next = String(img.dataset.covers || img.getAttribute("data-fallback") || "")
    .split("|")
    .map((url) => url.trim())
    .filter(Boolean);
  if (next.length && img.getAttribute("src") !== next[0]) {
    img.dataset.covers = next.slice(1).join("|");
    img.removeAttribute("data-fallback");
    img.src = next[0];
    return;
  }
  const ph = document.createElement("div");
  ph.className = "gwd-deal-ph";
  img.replaceWith(ph);
}
window.dealCoverError = dealCoverError;

function libCoverError(img) {
  if (isEpicCoverUrl(img.getAttribute("src"))) {
    const ph = document.createElement("span");
    ph.className = "lib-cover-empty";
    ph.setAttribute("aria-hidden", "true");
    img.replaceWith(ph);
    return;
  }
  const next = String(img.dataset.covers || "")
    .split("|")
    .map((url) => url.trim())
    .filter(Boolean);
  if (next.length) {
    img.dataset.covers = next.slice(1).join("|");
    img.src = next[0];
    return;
  }
  const ph = document.createElement("span");
  ph.className = "lib-cover-empty";
  ph.setAttribute("aria-hidden", "true");
  img.replaceWith(ph);
}

function libCard(game, skipped) {
  const hours = formatLibHours(libHours(game));
  const hoursEl = hours.never
    ? `<span class="gwd-bl-never">${esc(hours.text)}</span>`
    : `<span class="gwd-bl-hours">${esc(hours.text)}</span>`;
  const family = game.family ? ` <span class="gwd-bl-family">Família</span>` : "";
  const epic = game.store === "epic" ? ` <span class="gwd-bl-epic">Epic</span>` : "";
  const reviews =
    game.reviewPercent != null && Number.isFinite(Number(game.reviewPercent))
      ? `<span class="gwd-bl-reviews" title="${esc(String(game.reviewPercent))}% positivas${game.reviewTotal ? ` · ${Number(game.reviewTotal).toLocaleString("pt-BR")} análises` : ""}">${esc(String(game.reviewPercent))}%</span>`
      : "";
  const unpin =
    !skipped && window.libraryBoard?.isPinned?.(game.appId)
      ? `<button type="button" class="lib-unpin" data-unpin="${esc(game.appId)}" title="Devolver à faixa de horas">↩</button>`
      : "";
  const covers = libCoverList(game);
  const imgW = skipped ? 184 : 132;
  const imgH = skipped ? 69 : 50;
  const img = covers.length
    ? `<img src="${esc(covers[0])}" alt="" width="${imgW}" height="${imgH}" draggable="false" loading="lazy" decoding="async" data-covers="${esc(covers.slice(1).join("|"))}" onerror="libCoverError(this)">`
    : `<span class="lib-cover-empty" aria-hidden="true"></span>`;
  const link = `<a class="lib-link" href="${esc(game.storeUrl || "#")}" draggable="false">${img}<span class="lib-name" title="${esc(game.name || "")}">${esc(game.name || "")}</span></a>`;
  if (skipped) {
    const foot = reviews || family || epic ? `<span class="lib-card-reviews">${reviews}${family}${epic}</span>` : "";
    return `<article class="lib-card" data-app-id="${esc(game.appId)}">
      <input type="checkbox" data-skip="${esc(game.appId)}" checked title="Devolver à biblioteca">
      ${link}
      <span class="lib-card-stats">
        <span class="lib-card-hours">${hoursEl}</span>
        ${foot}
      </span>
    </article>`;
  }
  return `<article class="lib-card" data-app-id="${esc(game.appId)}" draggable="true">
    <input type="checkbox" data-skip="${esc(game.appId)}" title="Não vou jogar">
    <span class="lib-move" title="Arrastar para outra lista" aria-hidden="true">⋮⋮</span>
    ${link}
    ${hoursEl}${reviews}${family}${epic}${unpin}
  </article>`;
}

function toneMenuHtml(listId, current) {
  const tones = window.libraryBoard?.tones;
  if (!Array.isArray(tones) || !tones.length) return "";
  const tone = tones.some((item) => item.id === current) ? current : "green";
  const swatches = tones
    .map(
      (item) =>
        `<button type="button" class="lib-tone-swatch is-${esc(item.id)}${item.id === tone ? " is-current" : ""}" data-set-tone="${esc(item.id)}" data-list-id="${esc(listId)}" title="${esc(item.label)}" aria-label="${esc(item.label)}"></button>`
    )
    .join("");
  return `<div class="lib-tone-wrap">
    <button type="button" class="lib-list-btn lib-tone-btn" data-list-tone="${esc(listId)}" title="Cor da lista" aria-label="Cor da lista" aria-haspopup="true" aria-expanded="false">
      <span class="lib-tone-dot" aria-hidden="true"></span>
    </button>
    <div class="lib-tone-menu" role="listbox" aria-label="Cores da lista">${swatches}</div>
  </div>`;
}

function shelfHtml(shelf, skipped) {
  const count = `${shelf.items.length} jogo${shelf.items.length === 1 ? "" : "s"}`;
  const hoursBit = shelf.hours > 0 ? ` · ${formatHoursPlain(shelf.hours)} no total` : "";
  const sort = ["hours", "reviews", "name", "recent"].includes(shelf.sort) ? shelf.sort : "hours";
  const tones = window.libraryBoard?.tones;
  const tone =
    Array.isArray(tones) && tones.some((item) => item.id === shelf.tone) ? shelf.tone : shelf.tone === "red" ? "red" : "green";
  const empty = shelf.items.length
    ? shelf.items.map((game) => libCard(game, skipped)).join("")
    : `<div class="lib-drop-hint">Arraste um jogo para cá</div>`;
  return `<section class="lib-group is-${esc(tone)} board-tile" data-board-tile="${esc(shelf.key)}">
    <div class="lib-group-head">
      <div class="lib-group-title" data-list-id="${esc(shelf.key)}">${esc(shelf.title)}</div>
      <div class="lib-group-extra">${esc(shelf.extra)} · ${esc(count)}${esc(hoursBit)}</div>
      <div class="lib-list-actions">
        ${toneMenuHtml(shelf.key, tone)}
        <select class="lib-sort" data-list-sort="${esc(shelf.key)}" title="Ordenar só esta lista" aria-label="Ordenar ${esc(shelf.title)}">
          <option value="hours"${sort === "hours" ? " selected" : ""}>Horas</option>
          <option value="reviews"${sort === "reviews" ? " selected" : ""}>Reviews</option>
          <option value="name"${sort === "name" ? " selected" : ""}>Nome</option>
          <option value="recent"${sort === "recent" ? " selected" : ""}>Recente</option>
        </select>
        <button type="button" class="lib-list-btn" data-list-edit="${esc(shelf.key)}" title="Renomear lista">✎</button>
        <button type="button" class="lib-list-btn" data-list-del="${esc(shelf.key)}" title="Remover lista">×</button>
      </div>
    </div>
    <div class="lib-grid">${empty}</div>
  </section>`;
}

function readEpicSession(state) {
  const meta = state?.libraryMeta || libraryMeta || {};
  const name = String(state?.epicDisplayName || meta.epicAccountName || "").trim();
  return {
    loggedIn: Boolean(state?.hasEpic || meta.epicLoggedIn || name),
    name,
    count: Number(meta.epicCount) || 0,
    source: String(meta.epicSource || ""),
    error: String(meta.epicError || "").trim(),
    fullLibrary: String(meta.epicSource || "") === "epic-library",
  };
}

function epicCtaHtml() {
  if (document.body.classList.contains("capacitor")) return "";
  const session = epicSession;
  if (session.loggedIn) {
    const who = session.name ? ` <b>${esc(session.name)}</b>` : "";
    const countBit = session.count
      ? session.fullLibrary
        ? ` · ${session.count} jogo(s) da conta`
        : ` · ${session.count} no app (biblioteca da conta ainda não veio)`
      : "";
    const err = session.error ? ` ${esc(session.error)}` : "";
    return `<div class="lib-epic-cta is-on">
    <p>Sessão Epic ativa:${who}${countBit}.${err} Este app está logado. Finalizar a sessão não desconecta o launcher da Epic.</p>
    <div class="lib-epic-cta-actions">
      <button type="button" id="btnEpicLogoutJogos">Finalizar sessão?</button>
    </div>
  </div>`;
  }
  const n = Number(libraryMeta.epicCount) || 0;
  const localNote = n
    ? `Na Epic, agora só entram os ${n} jogo(s) instalado(s) neste PC.`
    : "Na Epic ainda não há jogos instalados neste PC.";
  if (libraryMeta.hasEglSession) {
    const who = libraryMeta.eglDisplayName ? ` como <b>${esc(libraryMeta.eglDisplayName)}</b>` : "";
    return `<div class="lib-epic-cta">
    <p>${localNote} O launcher da Epic neste PC já está conectado${who}. Autorize este app a listar a biblioteca da conta (a senha não passa por aqui).</p>
    <div class="lib-epic-cta-actions">
      <button type="button" id="btnEpicLoginJogos">Usar o launcher da Epic</button>
      <button type="button" class="ghost" id="btnEpicLoginWeb">Entrar no site da Epic</button>
    </div>
  </div>`;
  }
  return `<div class="lib-epic-cta">
    <p>${localNote} A biblioteca inteira da conta só aparece depois do login (a senha fica na Epic).</p>
    <button type="button" id="btnEpicLoginJogos">Puxar biblioteca da Epic</button>
  </div>`;
}

function paintLibrary() {
  libraryPaintDirty = false;
  const query = normalizeQuery($("jogosSearch")?.value);
  const list = libraryGames.filter((game) => nameMatches(game.name, query));
  const shelves = window.libraryBoard?.group ? window.libraryBoard.group(list) : groupByHours(list);
  const never = list.filter((game) => libHours(game) <= 0).length;
  const totalHours = list.reduce((sum, game) => sum + libHours(game), 0);
  const hintBits = [
    `${list.length} jogos · ${formatHoursPlain(totalHours)}`,
    never ? `${never} nunca tocados` : "",
    libraryMeta.sourceHint || "",
  ].filter(Boolean);
  $("jogosHint").textContent = query
    ? `${list.length} resultado(s) na biblioteca`
    : hintBits.join(" · ");
  const meta = libraryMeta.hint
    ? `<div class="lib-meta">${esc(libraryMeta.hint)} Marque um jogo para mandar para <b>Não vou jogar</b>.</div>`
    : `<div class="lib-meta">Marque um jogo para <b>Não vou jogar</b>. Arraste um jogo para outra lista. Cada lista tem ordem própria (Horas, Reviews % positivas, Nome, Recente) e uma cor.</div>`;
  const body = shelves.map((shelf) => shelfHtml(shelf, false)).join("");
  $("jogos").innerHTML = meta + epicCtaHtml() + (body || `<div class="empty-games">Nenhum jogo na biblioteca. Clique em Atualizar agora.</div>`);
  if (window.layoutBoard) window.layoutBoard.apply($("jogos"), "jogos");
  if (window.libraryBoard) {
    window.libraryBoard.ensureTools($("jogos"));
    window.libraryBoard.bind($("jogos"), { onChange: () => paintLibrary() });
  }
  if ($("btnEpicLoginJogos")) {
    $("btnEpicLoginJogos").onclick = () =>
      epicLoginFromUi(libraryMeta.hasEglSession ? { mode: "egl" } : undefined);
  }
  if ($("btnEpicLoginWeb")) $("btnEpicLoginWeb").onclick = () => epicLoginFromUi({ mode: "web" });
  if ($("btnEpicLogoutJogos")) $("btnEpicLogoutJogos").onclick = () => epicLogoutFromUi();
}

function readBacklogSort() {
  try {
    const raw = localStorage.getItem(BACKLOG_SORT_KEY);
    if (BACKLOG_SORTS.includes(raw)) return raw;
  } catch {
    // quota
  }
  return "hours";
}

function applyBacklogSort(sort, persist) {
  const next = BACKLOG_SORTS.includes(sort) ? sort : "hours";
  const changed = next !== backlogSort;
  backlogSort = next;
  const sel = $("backlogSort");
  if (sel && sel.value !== backlogSort) sel.value = backlogSort;
  try {
    localStorage.setItem(BACKLOG_SORT_KEY, backlogSort);
  } catch {
    // quota
  }
  if (persist && changed && window.steamApp && typeof window.steamApp.saveSettings === "function") {
    window.steamApp.saveSettings({ backlogSort }).catch(() => {});
  }
}

function paintSkipped() {
  skippedPaintDirty = false;
  const query = normalizeQuery($("backlogSearch")?.value);
  const filtered = skippedGames.filter((game) => nameMatches(game.name, query));
  const list = window.libraryBoard?.sortItems ? window.libraryBoard.sortItems(filtered, backlogSort) : filtered;
  const sortLabel =
    backlogSort === "reviews"
      ? "reviews % positivas"
      : backlogSort === "name"
        ? "nome"
        : backlogSort === "recent"
          ? "recentes"
          : "horas";
  $("backlogHint").textContent = query
    ? `${list.length} resultado(s) em Não vou jogar`
    : `${list.length} jogos · ordem: ${sortLabel} · desmarque para devolver à biblioteca`;
  const meta = `<div class="lib-meta">Esta lista não apaga o jogo da Steam. Desmarque para devolver à aba <b>Jogos</b>. A ordem (Horas, Reviews % positivas, Nome, Recente) vale para a lista inteira.</div>`;
  const cards = list.map((game) => libCard(game, true)).join("");
  $("backlogSkipped").innerHTML =
    meta +
    (cards ? `<div class="lib-grid">${cards}</div>` : `<div class="empty-games">Nenhum jogo em Não vou jogar.</div>`);
}

function isSyncBusy() {
  return syncUiLocks > 0 || Boolean(lastUiState?.syncing);
}

function applySyncButton() {
  const btn = $("btnSync");
  if (!btn) return;
  const connected = Boolean(lastUiState?.steamId || lastUiState?.profileUrl || lastUiState?.paired);
  const busy = isSyncBusy();
  btn.disabled = busy || !connected;
  btn.classList.toggle("is-syncing", busy);
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  document.body.classList.toggle("is-syncing", busy);
}

function setSyncingUi(syncing) {
  if (syncing) syncUiLocks += 1;
  else syncUiLocks = Math.max(0, syncUiLocks - 1);
  applySyncButton();
}

function paintAccount(state) {
  const connected = Boolean(state?.steamId || state?.profileUrl);
  const label = String(state?.steamId || state?.profileUrl || "").trim();
  const status = $("accountStatus");
  const logout = $("btnLogout");
  if (status) {
    if (state?.paired) {
      status.textContent = connected
        ? `Conectado: ${label} · Steam neste celular`
        : `Pareado com o PC`;
    } else {
      status.textContent = connected ? `Conectado: ${label}` : "Não conectado";
    }
  }
  if (logout) logout.disabled = !connected;
  const epicStatus = $("epicStatus");
  const epicOut = $("btnEpicLogout");
  const epicEgl = $("btnEpicLoginEgl");
  const epicWeb = $("btnEpicLogin");
  const epicHint = $("epicHint");
  const epicBox = epicStatus?.closest(".account-box");
  const session = readEpicSession(state);
  if (epicBox) epicBox.classList.toggle("is-epic-on", session.loggedIn);
  if (epicStatus) {
    epicStatus.classList.toggle("is-on", session.loggedIn);
    if (session.loggedIn) {
      const who = session.name || "conectada";
      const countBit = session.count
        ? session.fullLibrary
          ? ` · ${session.count} jogo(s) da conta`
          : ` · ${session.count} no app`
        : "";
      const err = session.error ? ` · ${session.error}` : "";
      epicStatus.textContent = `Sessão Epic ativa: ${who}${countBit}${err}`;
    } else if (state?.libraryMeta?.hasEglSession) {
      const who = state.libraryMeta.eglDisplayName ? ` (${state.libraryMeta.eglDisplayName})` : "";
      epicStatus.textContent = `Launcher da Epic conectado neste PC${who} · autorize para puxar a biblioteca`;
    } else {
      epicStatus.textContent = "Epic Games: sem sessão neste app · só os jogos instalados neste PC";
    }
  }
  if (epicOut) {
    epicOut.classList.toggle("hidden", !session.loggedIn);
    epicOut.disabled = !session.loggedIn;
  }
  if (epicEgl) epicEgl.classList.toggle("hidden", session.loggedIn || !state?.libraryMeta?.hasEglSession);
  if (epicWeb) epicWeb.classList.toggle("hidden", session.loggedIn);
  if (epicHint) {
    epicHint.innerHTML = session.loggedIn
      ? "Este app está logado na Epic. <b>Finalizar sessão</b> só desconecta daqui; o launcher oficial continua."
      : "Sem sessão neste app, Jogos só lista o que está instalado neste PC. Se o launcher da Epic já estiver conectado, <b>Usar o launcher</b> pede só uma autorização (a senha não passa por aqui). <b>Entrar no site</b> abre a página da Epic. A loja não entrega horas de jogo.";
  }
  paintPcLink(state);
}

function paintPcLink(state) {
  const status = $("pcLinkStatus");
  const host = $("pcHostInput");
  const code = $("pcCodeInput");
  const disconnect = $("btnPcDisconnect");
  if (status) {
    status.textContent = state?.paired
      ? state?.seededFromPc
        ? `Vinculado ao PC · marcas no Wi‑Fi · Steam neste celular`
        : `Vinculado ao PC · espelhando…`
      : "Sem vínculo com o PC";
  }
  if (host && state?.pcHost) {
    const raw = String(state.pcHost).replace(/^https?:\/\//i, "").replace(/:\d+$/, "");
    if (!host.value) host.value = raw;
  }
  if (code) {
    code.placeholder = state?.paired ? "já salvo neste celular" : "000000";
  }
  if (disconnect) disconnect.disabled = !state?.paired;
}

function paintPhoneLink(info) {
  const on = Boolean(info?.enabled && info?.code);
  const codeEl = $("phoneLinkCode");
  const urlEl = $("phoneLinkUrl");
  const qrEl = $("phoneLinkQr");
  const hintEl = $("phoneLinkHint");
  const offBtn = $("btnPhoneLinkOff");
  if (codeEl) {
    codeEl.textContent = on ? info.code : "";
    codeEl.classList.toggle("hidden", !on);
  }
  const url = on ? info.urls?.[0] || "" : "";
  const ips = (info?.ips || []).join(" · ");
  if (urlEl) {
    urlEl.textContent = on
      ? `IP: ${ips || "sem IPv4 na LAN"} · ${url}`
      : "";
    urlEl.classList.toggle("hidden", !on);
  }
  if (qrEl) {
    if (on && url) {
      qrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&ecc=M&data=${encodeURIComponent(url)}`;
      qrEl.classList.remove("hidden");
    } else {
      qrEl.removeAttribute("src");
      qrEl.classList.add("hidden");
    }
  }
  if (hintEl) {
    hintEl.textContent = on
      ? info.hint || ""
      : "Ligue para gerar um código de 6 dígitos. O celular precisa estar no mesmo Wi‑Fi. No Firewall do Windows, permita Node.js / Electron na rede privada.";
  }
  if (offBtn) offBtn.disabled = !on;
}

async function refreshPhoneLinkUi() {
  if (!window.steamApp?.phoneLinkStatus) return;
  try {
    paintPhoneLink(await window.steamApp.phoneLinkStatus());
  } catch {
    paintPhoneLink({ enabled: false });
  }
}

async function steamLoginFromUi() {
  if (isSyncBusy()) return;
  showError("");
  setSyncingUi(true);
  try {
    const state = await window.steamApp.login();
    if (state) render(state);
    closeSettings();
    await window.steamApp.sync();
    await refresh();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setSyncingUi(false);
  }
}

async function steamLogoutFromUi() {
  showError("");
  try {
    const state = window.steamApp.logout
      ? await window.steamApp.logout()
      : await window.steamApp.saveSettings({ steamId: "", profileUrl: "" });
    render(state);
    closeSettings();
  } catch (error) {
    showError(error.message || String(error));
  }
}

function render(state) {
  lastUiState = state;
  const connected = Boolean(state.steamId || state.profileUrl || state.paired);
  $("setup").classList.toggle("hidden", connected);
  $("dash").classList.toggle("hidden", !connected);
  $("statusLine").textContent = formatSyncStatus(state);
  applySyncButton();
  paintAccount(state);
  $("wishCount").textContent = state.wishCount || 0;
  $("saleCount").textContent = state.onSale || 0;
  $("comingCount").textContent = state.comingCount || 0;
  $("fullCount").textContent = state.fullCount || 0;
  $("eaCount").textContent = state.eaCount ?? state.aaCount ?? 0;
  $("hours").value = String(state.syncEveryHours || 12);
  $("notifySales").checked = state.notifySales !== false;
  $("notifyNews").checked = state.notifyNews !== false;
  $("startWin").checked = state.startWithWindows !== false;
  if ($("dataPath")) {
    $("dataPath").textContent = state.backupPath
      ? `Cópia automática neste PC. Ajustes → Exportar cópia se for formatar o Windows.`
      : "";
  }
  if ($("appVersionLine")) {
    $("appVersionLine").textContent = state.appVersion ? `Versão ${state.appVersion}` : "Versão";
  }
  savedTheme = normalizeTheme(state.theme);
  if (!themeDirty) {
    fillThemeInputs(savedTheme);
    applyTheme(savedTheme);
  }
  if (window.layoutBoard && state.layout) window.layoutBoard.mergeFromServer(state.layout);
  if (window.libraryBoard && state.libraryLists) window.libraryBoard.mergeFromServer(state.libraryLists);
  if (BACKLOG_SORTS.includes(state.backlogSort)) applyBacklogSort(state.backlogSort, false);
  else applyBacklogSort(readBacklogSort(), false);
  $("novidades").innerHTML =
    state.novidadesHtml ||
    `<div class="gwd-updates gwd-updates-quiet">Nenhuma atualização na wishlist nos últimos 7 dias.</div>`;
  $("loja").innerHTML =
    state.lojaHtml || `<div class="gwd-empty">Sem dados da loja ainda. Clique em Atualizar agora.</div>`;
  wishGames = state.games || [];
  libraryGames = state.libraryGames || [];
  skippedGames = state.skippedGames || [];
  libraryMeta = state.libraryMeta || {};
  epicSession = readEpicSession(state);
  paintTabCounts();
  paintGames();
  if (activeTab === "jogos") paintLibrary();
  else libraryPaintDirty = true;
  if (activeTab === "backlog") paintSkipped();
  else skippedPaintDirty = true;
  paintBoards();
}

function paintTabCounts() {
  const set = (id, count) => {
    const el = $(id);
    if (el) el.textContent = String(Number(count) || 0);
  };
  set("tabCountWishlist", wishGames.length);
  set("tabCountJogos", libraryGames.length);
  set("tabCountBacklog", skippedGames.length);
}

function paintBoards() {
  if (!window.layoutBoard) return;
  const nov = document.querySelector("#novidades [data-board='novidades']");
  const loja = document.querySelector("#loja [data-board='loja']");
  if (nov) window.layoutBoard.apply(nov, "novidades");
  if (loja) window.layoutBoard.apply(loja, "loja");
}

function showError(message) {
  $("error").classList.toggle("hidden", !message);
  $("error").textContent = message || "";
}

async function refresh() {
  const state = await window.steamApp.getState();
  render(state);
  return state;
}

$("btnHide").onclick = () => window.steamApp?.hide();
$("btnSync").onclick = async () => {
  if (isSyncBusy()) return;
  showError("");
  setSyncingUi(true);
  try {
    const result = await window.steamApp.sync();
    if (!result?.ok) showError(result?.message || "Falha ao sincronizar.");
    if (result?.state) render(result.state);
    else await refresh();
  } catch (error) {
    showError(error.message || String(error));
    try {
      await refresh();
    } catch {
      if (lastUiState) lastUiState.syncing = false;
    }
  } finally {
    setSyncingUi(false);
  }
};
$("btnLogin").onclick = () => steamLoginFromUi();
if ($("btnSteamLogin")) $("btnSteamLogin").onclick = () => steamLoginFromUi();
async function epicLoginFromUi(opts) {
  if (!window.steamApp?.epicLogin) return;
  showError("");
  setSyncingUi(true);
  try {
    const state = await window.steamApp.epicLogin(opts || {});
    if (state) {
      render(state);
      const session = readEpicSession(state);
      if (session.loggedIn) {
        showError("");
        $("statusLine").textContent = session.name
          ? `Sessão Epic ativa: ${session.name}`
          : "Sessão Epic ativa neste app";
      }
    }
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setSyncingUi(false);
  }
}

async function epicLogoutFromUi() {
  if (!window.steamApp?.epicLogout) return;
  const who = epicSession.name ? ` (${epicSession.name})` : "";
  const ok = window.confirm(`Finalizar a sessão da Epic neste app${who}? O launcher oficial continua logado.`);
  if (!ok) return;
  showError("");
  try {
    const state = await window.steamApp.epicLogout();
    if (state) render(state);
  } catch (error) {
    showError(error.message || String(error));
  }
}

if ($("btnEpicLogin")) $("btnEpicLogin").onclick = () => epicLoginFromUi({ mode: "web" });
if ($("btnEpicLoginEgl")) $("btnEpicLoginEgl").onclick = () => epicLoginFromUi({ mode: "egl" });
if ($("btnEpicLogout")) $("btnEpicLogout").onclick = () => epicLogoutFromUi();
if ($("btnLogout")) $("btnLogout").onclick = () => steamLogoutFromUi();
$("btnSaveSetup").onclick = async () => {
  if (isSyncBusy()) return;
  showError("");
  setSyncingUi(true);
  try {
    await window.steamApp.saveSettings({
      steamId: $("steamIdInput").value.trim(),
      steamWebApiKey: $("apiKeyInput").value.trim(),
    });
    const result = await window.steamApp.sync();
    if (!result?.ok) showError(result?.message || "Conecte a Steam e tente de novo.");
    await refresh();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setSyncingUi(false);
  }
};
function refreshIconPreview() {
  $("iconPreview").src = `../icon.png?t=${Date.now()}`;
}
$("btnShortcut").onclick = async () => {
  $("shortcutMsg").textContent = "Criando atalho…";
  try {
    const result = await window.steamApp.createShortcuts();
    $("shortcutMsg").textContent = result.message || (result.ok ? "Atalho criado." : "Falha ao criar atalho.");
  } catch (error) {
    $("shortcutMsg").textContent = error.message || String(error);
  }
};
$("btnPickIcon").onclick = async () => {
  $("iconMsg").textContent = "";
  try {
    const result = await window.steamApp.pickIcon();
    if (result.canceled) return;
    $("iconMsg").textContent = result.message || (result.ok ? "Ícone atualizado." : "Não deu para trocar o ícone.");
    if (result.ok) refreshIconPreview();
  } catch (error) {
    $("iconMsg").textContent = error.message || String(error);
  }
};
$("btnResetIcon").onclick = async () => {
  $("iconMsg").textContent = "";
  try {
    const result = await window.steamApp.resetIcon();
    $("iconMsg").textContent = result.message || (result.ok ? "Ícone padrão restaurado." : "Não deu para restaurar.");
    if (result.ok) refreshIconPreview();
  } catch (error) {
    $("iconMsg").textContent = error.message || String(error);
  }
};
if ($("btnExportBackup") && window.steamApp?.exportBackup) {
  $("btnExportBackup").onclick = async () => {
    const msg = $("backupMsg");
    if (msg) msg.textContent = "Salvando…";
    try {
      const result = await window.steamApp.exportBackup();
      if (result.canceled) {
        if (msg) msg.textContent = "";
        return;
      }
      if (msg) {
        msg.textContent = result.ok
          ? `Cópia salva · ${result.skipped || 0} jogos em Não vou jogar.`
          : result.message || "Não deu para exportar.";
      }
    } catch (error) {
      if (msg) msg.textContent = error.message || String(error);
    }
  };
}
if ($("btnImportBackup") && window.steamApp?.importBackup) {
  $("btnImportBackup").onclick = async () => {
    const msg = $("backupMsg");
    if (msg) msg.textContent = "Lendo arquivo…";
    try {
      const result = await window.steamApp.importBackup();
      if (result.canceled) {
        if (msg) msg.textContent = "";
        return;
      }
      if (msg) {
        msg.textContent = result.ok
          ? `Restaurado · ${result.skipped || 0} marcações.`
          : result.message || "Arquivo inválido.";
      }
      await refresh();
    } catch (error) {
      if (msg) msg.textContent = error.message || String(error);
    }
  };
}
if ($("btnDownloadApk")) {
  $("btnDownloadApk").onclick = () => {
    const url = "https://github.com/CristopherBauler/SteamControles/releases";
    if (window.steamApp?.openUrl) window.steamApp.openUrl(url);
    else window.open(url, "_blank", "noopener");
  };
}
$("search").oninput = () => paintGames();
$("jogosSearch").oninput = () => {
  clearTimeout(jogosSearchTimer);
  jogosSearchTimer = setTimeout(() => paintLibrary(), 160);
};
$("backlogSearch").oninput = () => {
  clearTimeout(backlogSearchTimer);
  backlogSearchTimer = setTimeout(() => paintSkipped(), 160);
};
if ($("backlogSort")) {
  $("backlogSort").onchange = () => {
    applyBacklogSort($("backlogSort").value, true);
    paintSkipped();
  };
}

async function onSkipToggle(event) {
  const input = event.target.closest("input[data-skip]");
  if (!input || libraryBusy) return;
  libraryBusy = true;
  input.disabled = true;
  try {
    if (input.checked) applyBacklogSort("recent", true);
    const state = await window.steamApp.toggleSkipped({
      appId: Number(input.dataset.skip),
      skipped: input.checked,
    });
    render(state);
  } catch (error) {
    showError(error.message || String(error));
    input.checked = !input.checked;
    input.disabled = false;
  } finally {
    libraryBusy = false;
  }
}
$("jogos").addEventListener("change", onSkipToggle);
$("backlogSkipped").addEventListener("change", onSkipToggle);

function openSettings() {
  $("settingsModal").classList.remove("hidden");
  refreshPhoneLinkUi();
}
function closeSettings() {
  $("settingsModal").classList.add("hidden");
  if (themeDirty) {
    themeDirty = false;
    fillThemeInputs(savedTheme);
    applyTheme(savedTheme);
  }
}
$("btnSettings").onclick = openSettings;
$("btnCloseSettings").onclick = closeSettings;
if ($("btnPhoneLinkOn")) {
  $("btnPhoneLinkOn").onclick = async () => {
    if (!window.steamApp?.startPhoneLink) return;
    $("phoneLinkHint").textContent = "Abrindo na rede local…";
    try {
      paintPhoneLink(await window.steamApp.startPhoneLink());
    } catch (error) {
      $("phoneLinkHint").textContent =
        error.message ||
        "Não subi o servidor. A porta 17331 pode estar em uso, ou o firewall bloqueou.";
    }
  };
}
if ($("btnPhoneLinkOff")) {
  $("btnPhoneLinkOff").onclick = async () => {
    if (!window.steamApp?.stopPhoneLink) return;
    try {
      paintPhoneLink(await window.steamApp.stopPhoneLink());
    } catch (error) {
      $("phoneLinkHint").textContent = error.message || String(error);
    }
  };
}
if ($("btnPcConnect")) {
  $("btnPcConnect").onclick = async () => {
    if (!window.steamApp?.connectPc) return;
    const msg = $("pcLinkMsg");
    if (msg) msg.textContent = "Conectando…";
    try {
      const state = await window.steamApp.connectPc({
        host: $("pcHostInput")?.value || "",
        code: $("pcCodeInput")?.value || "",
      });
      if ($("pcCodeInput")) $("pcCodeInput").value = "";
      if (msg) msg.textContent = "Espelhado. Daqui pra frente Atualizar usa a Steam neste celular; Não vou jogar ainda fala com o PC no Wi‑Fi.";
      render(state);
    } catch (error) {
      if (msg) msg.textContent = error.message || String(error);
    }
  };
}
if ($("btnReseedPc")) {
  $("btnReseedPc").onclick = async () => {
    if (!window.steamApp?.reseedFromPc) return;
    const msg = $("pcLinkMsg");
    if (msg) msg.textContent = "Puxando o PC…";
    try {
      const result = await window.steamApp.reseedFromPc();
      if (!result.ok) {
        if (msg) msg.textContent = result.message || "Não achei o PC.";
        if (result.state) render(result.state);
        return;
      }
      if (msg) msg.textContent = "Cópia nova do PC. Depois cada um volta a atualizar sozinho.";
      render(result.state);
    } catch (error) {
      if (msg) msg.textContent = error.message || String(error);
    }
  };
}
if ($("btnPcDisconnect")) {
  $("btnPcDisconnect").onclick = async () => {
    if (!window.steamApp?.disconnectPc) return;
    const msg = $("pcLinkMsg");
    try {
      const state = await window.steamApp.disconnectPc();
      if (msg) msg.textContent = "Desconectado do PC. Atualizar volta a usar a Steam neste celular.";
      render(state);
    } catch (error) {
      if (msg) msg.textContent = error.message || String(error);
    }
  };
}
$("settingsBackdrop").onclick = closeSettings;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("settingsModal").classList.contains("hidden")) closeSettings();
});
$("btnResetColors").onclick = () => {
  fillThemeInputs(DEFAULT_THEME);
  previewThemeFromInputs();
};
["colorGeneral", "colorButton", ...TABS.map((id) => `colorTab-${id}`)].forEach((id) => {
  $(id).addEventListener("input", previewThemeFromInputs);
});
$("btnSaveSettings").onclick = async () => {
  savedTheme = normalizeTheme(readThemeFromInputs());
  themeDirty = false;
  applyTheme(savedTheme);
  await window.steamApp.saveSettings({
    syncEveryHours: Number($("hours").value),
    notifySales: $("notifySales").checked,
    notifyNews: $("notifyNews").checked,
    startWithWindows: $("startWin").checked,
    steamWebApiKey: $("apiKeyDash").value.trim(),
    theme: savedTheme,
  });
  $("apiKeyDash").value = "";
  await refresh();
  closeSettings();
};
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => showTab(btn.dataset.tab);
});
document.querySelectorAll("#wishStats .stat").forEach((btn) => {
  btn.onclick = () => {
    showTab("wishlist");
    setWishFilter(btn.dataset.filter);
  };
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  const href = link.getAttribute("href");
  if (href && (href.startsWith("http") || href.startsWith("steam:"))) {
    event.preventDefault();
    if (window.steamApp) window.steamApp.openUrl(href);
    else window.open(href, "_blank", "noopener");
  }
});
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("is-app-hidden", document.hidden);
});
document.body.classList.toggle("is-app-hidden", document.hidden);
showTab("novidades");
if (window.steamApp) {
window.steamApp.onSync((payload) => {
  if (payload?.error) showError(payload.error);
  if (payload?.state) {
    render(payload.state);
    return;
  }
  if (payload?.syncing) {
    lastUiState = { ...(lastUiState || {}), syncing: true };
    applySyncButton();
    $("statusLine").textContent = formatSyncStatus(payload);
    return;
  }
  refresh();
});
  refresh();
} else {
  $("statusLine").textContent = "Abra pelo app Minha Loja dos Desejos.";
  $("dash").classList.remove("hidden");
}
