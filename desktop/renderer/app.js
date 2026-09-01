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
let libraryBusy = false;
let savedTheme = { ...DEFAULT_THEME, tabs: { ...DEFAULT_THEME.tabs } };
let themeDirty = false;

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
      if (payload?.paired) {
        return `PC · último: ${when(payload?.lastSyncAt)} · Atualizar puxa do computador`;
      }
      return `Último sync: ${when(payload?.lastSyncAt)} · toque em Atualizar agora`;
    }
    return `Último sync: ${when(payload?.lastSyncAt)} · próximo ${when(payload?.nextSyncAt)}`;
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
    aa: all.filter((game) => game.earlyAccess),
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
  if (key === "aa") {
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
}

function setWishFilter(filter) {
  wishFilter = ["all", "sale", "soon", "full", "aa"].includes(filter) ? filter : "all";
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
    aa: "acesso antecipado · não lançados na frente, depois menor preço",
  };
  $("wishHint").textContent = query
    ? `${list.length} resultado(s) em ${labels[wishFilter]}`
    : `${list.length} jogos · ${labels[wishFilter]}`;
  $("games").innerHTML =
    list
      .map((game) => {
        const img = game.headerImage ? `<img src="${esc(game.headerImage)}" alt="">` : `<div class="ph"></div>`;
        const badge = game.earlyAccess ? `<span class="ea-badge">AA</span>` : "";
        return `<a class="game" href="${esc(game.storeUrl || "#")}">${img}<span>${esc(game.name || "")}</span><em>${esc(priceText(game))}${badge}</em></a>`;
      })
      .join("") || `<div class="empty-games">Nenhum jogo neste filtro.</div>`;
}

const HOUR_SHELVES = [
  { key: "h100", tone: "green", title: "Mais de 100 h", extra: "os que mais te consumiram", test: (h) => h >= 100 },
  { key: "h50", tone: "green", title: "50 a 100 h", extra: "já virou hábito", test: (h) => h >= 50 && h < 100 },
  { key: "h20", tone: "green", title: "20 a 50 h", extra: "bem avançados", test: (h) => h >= 20 && h < 50 },
  { key: "h10", tone: "green", title: "10 a 20 h", extra: "em andamento", test: (h) => h >= 10 && h < 20 },
  { key: "h1", tone: "red", title: "Menos de 10 h", extra: "só comecei", test: (h) => h > 0 && h < 10 },
  { key: "never", tone: "red", title: "Nunca jogado", extra: "zero horas neste PC", test: (h) => h <= 0 },
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
    const items = games.filter((game) => def.test(libHours(game)));
    const hours = items.reduce((sum, game) => sum + libHours(game), 0);
    return { ...def, items, hours };
  }).filter((shelf) => shelf.items.length);
}

function libCoverList(game) {
  const id = Number(game.appId);
  const list = [];
  const push = (url) => {
    const src = String(url || "").trim();
    if (!src || /library_hero/i.test(src) || list.includes(src)) return;
    list.push(src);
  };
  push(game.cover);
  if (Array.isArray(game.covers)) game.covers.forEach(push);
  if (Number.isInteger(id) && id > 0) {
    push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_231x87.jpg`);
    push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`);
    push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`);
    push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`);
  }
  return list;
}

function libCoverError(img) {
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
  const covers = libCoverList(game);
  const img = covers.length
    ? `<img src="${esc(covers[0])}" alt="" loading="lazy" data-covers="${esc(covers.slice(1).join("|"))}" onerror="libCoverError(this)">`
    : `<span class="lib-cover-empty" aria-hidden="true"></span>`;
  return `<article class="lib-card">
    <input type="checkbox" data-skip="${esc(game.appId)}" ${skipped ? "checked" : ""} title="${skipped ? "Devolver à biblioteca" : "Não vou jogar"}">
    <a class="lib-link" href="${esc(game.storeUrl || "#")}">${img}<span class="lib-name">${esc(game.name || "")}</span></a>
    ${hoursEl}${family}
  </article>`;
}

function shelfHtml(shelf, skipped) {
  const count = `${shelf.items.length} jogo${shelf.items.length === 1 ? "" : "s"}`;
  const hoursBit = shelf.hours > 0 ? ` · ${formatHoursPlain(shelf.hours)} no total` : "";
  return `<div class="lib-shelf">
    <div>
      <div class="lib-shelf-title">${esc(shelf.title)}</div>
      <div class="lib-shelf-kicker">${esc(shelf.extra)}</div>
    </div>
    <div class="lib-shelf-extra">${esc(count)}${esc(hoursBit)}</div>
  </div>
  <div class="lib-grid">${shelf.items.map((game) => libCard(game, skipped)).join("")}</div>`;
}

function groupHtml(tone, title, extra, shelves, skipped) {
  if (!shelves.length) return "";
  return `<section class="lib-group is-${esc(tone)}">
    <div class="lib-group-head">
      <div class="lib-group-title">${esc(title)}</div>
      <div class="lib-group-extra">${esc(extra)}</div>
    </div>
    ${shelves.map((shelf) => shelfHtml(shelf, skipped)).join("")}
  </section>`;
}

function paintLibrary() {
  const query = normalizeQuery($("jogosSearch")?.value);
  const list = libraryGames.filter((game) => nameMatches(game.name, query));
  const shelves = groupByHours(list);
  const played = shelves.filter((shelf) => shelf.tone === "green");
  const leftover = shelves.filter((shelf) => shelf.tone === "red");
  const playedCount = played.reduce((sum, shelf) => sum + shelf.items.length, 0);
  const leftoverCount = leftover.reduce((sum, shelf) => sum + shelf.items.length, 0);
  const playedHours = played.reduce((sum, shelf) => sum + shelf.hours, 0);
  const leftoverHours = leftover.reduce((sum, shelf) => sum + shelf.hours, 0);
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
    : `<div class="lib-meta">Marque um jogo para mandar para <b>Não vou jogar</b> (aba Backlog).</div>`;
  const body =
    groupHtml("green", "10 h ou mais", `${playedCount} jogos · ${formatHoursPlain(playedHours)} no total`, played, false) +
    groupHtml(
      "red",
      "Menos de 10 h",
      leftoverHours > 0
        ? `${leftoverCount} jogos · ${formatHoursPlain(leftoverHours)} jogadas · ${never} nunca tocados`
        : `${leftoverCount} jogos · ${never} nunca tocados`,
      leftover,
      false
    );
  $("jogos").innerHTML = meta + (body || `<div class="empty-games">Nenhum jogo na biblioteca. Clique em Atualizar agora.</div>`);
}

function paintSkipped() {
  const query = normalizeQuery($("backlogSearch")?.value);
  const list = skippedGames.filter((game) => nameMatches(game.name, query));
  $("backlogHint").textContent = query
    ? `${list.length} resultado(s) em Não vou jogar`
    : `${list.length} jogos · desmarque para devolver à biblioteca`;
  const meta = `<div class="lib-meta">Esta lista não apaga o jogo da Steam. Desmarque para devolver à aba <b>Jogos</b>.</div>`;
  const cards = list.map((game) => libCard(game, true)).join("");
  $("backlogSkipped").innerHTML =
    meta +
    (cards ? `<div class="lib-grid">${cards}</div>` : `<div class="empty-games">Nenhum jogo em Não vou jogar.</div>`);
}

function setSyncingUi(syncing) {
  const on = Boolean(syncing);
  document.body.classList.toggle("is-syncing", on);
  $("btnSync").classList.toggle("is-syncing", on);
}

function paintAccount(state) {
  const connected = Boolean(state?.steamId || state?.profileUrl);
  const label = String(state?.steamId || state?.profileUrl || "").trim();
  const status = $("accountStatus");
  const logout = $("btnLogout");
  if (status) {
    if (state?.paired) {
      status.textContent = connected
        ? `Conectado: ${label} · biblioteca do PC`
        : `Pareado com o PC`;
    } else {
      status.textContent = connected ? `Conectado: ${label}` : "Não conectado";
    }
  }
  if (logout) logout.disabled = !connected;
  paintPcLink(state);
}

function paintPcLink(state) {
  const status = $("pcLinkStatus");
  const host = $("pcHostInput");
  const code = $("pcCodeInput");
  const disconnect = $("btnPcDisconnect");
  if (status) {
    status.textContent = state?.paired
      ? `Vinculado ao PC ${state.pcHost || ""}`.trim()
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
  showError("");
  try {
    const state = await window.steamApp.login();
    if (state) render(state);
    closeSettings();
    await window.steamApp.sync();
    await refresh();
  } catch (error) {
    showError(error.message || String(error));
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
  const connected = Boolean(state.steamId || state.profileUrl || state.paired);
  $("setup").classList.toggle("hidden", connected);
  $("dash").classList.toggle("hidden", !connected);
  $("statusLine").textContent = formatSyncStatus(state);
  $("btnSync").disabled = state.syncing || !connected;
  setSyncingUi(state.syncing);
  paintAccount(state);
  $("wishCount").textContent = state.wishCount || 0;
  $("saleCount").textContent = state.onSale || 0;
  $("comingCount").textContent = state.comingCount || 0;
  $("fullCount").textContent = state.fullCount || 0;
  $("aaCount").textContent = state.aaCount || 0;
  $("hours").value = String(state.syncEveryHours || 12);
  $("notifySales").checked = state.notifySales !== false;
  $("notifyNews").checked = state.notifyNews !== false;
  $("startWin").checked = state.startWithWindows !== false;
  $("dataPath").textContent = state.dataPath || "";
  if ($("appVersionLine")) {
    $("appVersionLine").textContent = state.appVersion ? `Versão ${state.appVersion}` : "Versão";
  }
  savedTheme = normalizeTheme(state.theme);
  if (!themeDirty) {
    fillThemeInputs(savedTheme);
    applyTheme(savedTheme);
  }
  $("novidades").innerHTML =
    state.novidadesHtml ||
    `<div class="gwd-updates gwd-updates-quiet">Nenhuma atualização na wishlist nos últimos 7 dias.</div>`;
  $("loja").innerHTML =
    state.lojaHtml || `<div class="gwd-empty">Sem dados da loja ainda. Clique em Atualizar agora.</div>`;
  wishGames = state.games || [];
  libraryGames = state.libraryGames || [];
  skippedGames = state.skippedGames || [];
  libraryMeta = state.libraryMeta || {};
  paintGames();
  paintLibrary();
  paintSkipped();
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
  showError("");
  $("btnSync").disabled = true;
  setSyncingUi(true);
  const result = await window.steamApp.sync();
  if (!result.ok) showError(result.message || "Falha ao sincronizar.");
  if (result.state) render(result.state);
  else await refresh();
};
$("btnLogin").onclick = () => steamLoginFromUi();
if ($("btnSteamLogin")) $("btnSteamLogin").onclick = () => steamLoginFromUi();
if ($("btnLogout")) $("btnLogout").onclick = () => steamLogoutFromUi();
$("btnSaveSetup").onclick = async () => {
  showError("");
  await window.steamApp.saveSettings({
    steamId: $("steamIdInput").value.trim(),
    steamWebApiKey: $("apiKeyInput").value.trim(),
  });
  const result = await window.steamApp.sync();
  if (!result.ok) showError(result.message || "Conecte a Steam e tente de novo.");
  await refresh();
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
if ($("btnDownloadApk")) {
  $("btnDownloadApk").onclick = () => {
    const url = "https://github.com/CristopherBauler/SteamControles/releases";
    if (window.steamApp?.openUrl) window.steamApp.openUrl(url);
    else window.open(url, "_blank", "noopener");
  };
}
$("search").oninput = () => paintGames();
$("jogosSearch").oninput = () => paintLibrary();
$("backlogSearch").oninput = () => paintSkipped();

async function onSkipToggle(event) {
  const input = event.target.closest("input[data-skip]");
  if (!input || libraryBusy) return;
  libraryBusy = true;
  input.disabled = true;
  try {
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
      if (msg) msg.textContent = "Vinculado. Código salvo. Daqui pra frente é só Atualizar agora.";
      render(state);
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
    $("btnSync").disabled = true;
    setSyncingUi(true);
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
