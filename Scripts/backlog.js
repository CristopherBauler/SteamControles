/**
 * Backlog: biblioteca Steam inteira (sem corte de horas).
 * Atualizar só adiciona compras novas. Tarefas Markdown (- [ ] / - [x]) gravam sozinhas.
 */

const fs = require("fs/promises");
const path = require("path");
const { readJson, writeJson, nowIso } = require("./config");
const { fetchOwnedPlaytimes, fetchAppDetails, fetchReviews, mapPool } = require("./steamApi");

const NAME_RESOLVE_LIMIT = 15;
const REVIEW_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REVIEW_BATCH = 80;
const SKIP_APP_IDS = new Set([7, 228980, 250820]);
const SKIP_TYPES = new Set(["config", "tool"]);
const JUNK_NAME =
  /soundtrack|\bost\b|dedicated server|server dedicated|sound track|artwork book|^steamworks common|^steamvr\b|\bproton\b|^steam (game notes|input configs|screenshots|linux runtime)|eula$/i;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mdEsc(value) {
  return String(value ?? "").replace(/([\\*_`])/g, "\\$1");
}

function gameHours(game) {
  if (game?.hours != null && Number.isFinite(Number(game.hours))) return Number(game.hours);
  return Number(game?.playtimeMinutes || 0) / 60;
}

function isBareName(name) {
  return /^App \d+$/i.test(String(name || "").trim());
}

function isJunkGame(game) {
  if (SKIP_APP_IDS.has(Number(game.appId))) return true;
  const appType = String(game.appType || "").toLowerCase();
  if (SKIP_TYPES.has(appType)) return true;
  return JUNK_NAME.test(String(game.name || ""));
}

function formatHours(hours) {
  if (!hours || hours <= 0) return "Nunca jogado";
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded.toLocaleString("pt-BR", {
    minimumFractionDigits: rounded % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  })} h`;
}

function formatHoursPlain(hours) {
  const n = Math.max(0, Number(hours) || 0);
  const rounded = Math.round(n * 10) / 10;
  return `${rounded.toLocaleString("pt-BR", {
    minimumFractionDigits: rounded % 1 ? 1 : 0,
    maximumFractionDigits: 1,
  })} h`;
}

function hoursHtml(hours) {
  if (!hours || hours <= 0) {
    return `<span class="gwd-bl-never" style="color:#ff6b6b;font-weight:650">Nunca jogado</span>`;
  }
  return `<span class="gwd-bl-hours" style="color:#4da3ff;font-weight:650">${esc(formatHours(hours))}</span>`;
}

function familyHtml(game) {
  if (!game?.family) return "";
  return ` <span class="gwd-bl-family" style="color:#c9a227;font-weight:600">Família</span>`;
}

function isCommunityLogo(url) {
  return /(?:steamcommunity\.com|media\.steampowered\.com)\/(?:public\/)?images\/apps\/\d+\//i.test(
    String(url || "")
  );
}

function defaultCapsule(appId) {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${Number(appId)}/capsule_231x87.jpg`;
}

function isBannedCover(url) {
  return /library_hero/i.test(String(url || ""));
}

function coverCandidates(game, cached) {
  const id = Number(game.appId);
  const list = [];
  const push = (url) => {
    if (url && !isBannedCover(url)) list.push(url);
  };
  push(cached);
  push(game?.cover);
  push(game?.coverUrl);
  push(game?.capsuleImage);
  push(game?.headerImage);
  if (Number.isInteger(id) && id > 0) {
    push(defaultCapsule(id));
    push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`);
    push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`);
    push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`);
  }
  if (game?.logoHash && Number.isInteger(id) && id > 0) {
    push(`https://media.steampowered.com/steamcommunity/public/images/apps/${id}/${game.logoHash}.jpg`);
  }
  if (isCommunityLogo(game?.logo)) push(game.logo);
  return [...new Set(list.filter(Boolean))];
}

async function headOk(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(2500),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function coverSourceMap(raw) {
  return raw?.urls && typeof raw.urls === "object" ? raw.urls : raw || {};
}

function readCoverMap(raw) {
  const urls = {};
  for (const [key, value] of Object.entries(coverSourceMap(raw))) {
    if (!/^\d+$/.test(key) || !value || isBannedCover(value)) continue;
    urls[key] = String(value);
  }
  return urls;
}

function attachCachedCovers(games, coverMap) {
  for (const game of games || []) {
    const cached = coverMap[String(game.appId)];
    if (!cached || isBannedCover(cached)) continue;
    game.cover = cached;
    game.coverUrl = cached;
  }
  return games;
}

async function resolveCovers(games, cachePath, config = {}, options = {}) {
  const retryFailed = Boolean(options.retryFailed);
  const raw = await readJson(cachePath, {});
  const source = { ...coverSourceMap(raw) };
  const urls = readCoverMap(raw);
  const legacy = readCoverMap(await readJson(path.join(path.dirname(cachePath), "coverUrls.json"), {}));
  for (const [key, value] of Object.entries(legacy)) {
    if (!urls[key]) urls[key] = value;
  }
  const knownKeys = new Set(Object.keys(source).filter((key) => /^\d+$/.test(key)));

  const reportCover = (current, total) => {
    if (typeof options.onProgress === "function") {
      try {
        options.onProgress(current, total);
      } catch {
        // progress hooks must not break cover resolve
      }
    }
  };
  if (!games?.length) reportCover(1, 1);

  await mapPool(games, 8, async (game) => {
    const id = String(game.appId);
    if (urls[id] && !isBannedCover(urls[id])) {
      game.cover = urls[id];
      game.coverUrl = urls[id];
      return;
    }
    if (!retryFailed && knownKeys.has(id) && !urls[id]) {
      game.cover = game.cover && !isBannedCover(game.cover) ? game.cover : "";
      return;
    }
    try {
      const details = await fetchAppDetails(Number(game.appId), {
        country: config.country || "br",
        language: config.language || "portuguese",
        retries: 1,
        timeoutMs: 8000,
      });
      const apiCover = [details?.capsuleImage, details?.headerImage].find(
        (url) => url && !isBannedCover(url)
      );
      if (apiCover) {
        game.cover = apiCover;
        game.coverUrl = apiCover;
        urls[id] = apiCover;
        return;
      }
    } catch {
      // store API indisponível; cai nos chutes de CDN e tenta de novo no próximo sync
    }
    for (const candidate of coverCandidates(game, urls[id])) {
      if (await headOk(candidate)) {
        game.cover = candidate;
        game.coverUrl = candidate;
        urls[id] = candidate;
        return;
      }
    }
    game.cover = game.cover && !isBannedCover(game.cover) ? game.cover : "";
    if (!urls[id]) urls[id] = "";
  }, (done, total) => reportCover(done, total));

  const out = { ...source };
  for (const [key, value] of Object.entries(urls)) out[key] = value;
  await writeJson(cachePath, out);
  return games;
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

function extractAppId(line) {
  const comment = String(line).match(/<!--\s*app:?\s*(\d+)\s*-->/i);
  if (comment) return Number(comment[1]);
  const data = String(line).match(/data-appid="(\d+)"/);
  if (data) return Number(data[1]);
  const caret = String(line).match(/\^app(?:id)?[:\-]?(\d+)\s*$/i);
  if (caret) return Number(caret[1]);
  const steam = String(line).match(/\/(?:apps|app)\/(\d+)\//);
  if (steam) return Number(steam[1]);
  return 0;
}

function parseHoursToken(text) {
  if (/Nunca jogado/i.test(text)) return 0;
  const match = String(text).match(/([\d]+(?:[.,]\d+)?)\s*h/i);
  if (!match) return null;
  return Number(match[1].replace(",", "."));
}

function parseTaskLine(raw) {
  const match = String(raw).match(/^- \[([ xX])\](.*)$/);
  if (!match) return null;
  const rest = match[2];
  const appId = extractAppId(rest);
  if (!Number.isInteger(appId) || appId <= 0) return null;
  const bold = rest.match(/<strong>(.+?)<\/strong>/i) || rest.match(/\*\*(.+?)\*\*/);
  const name = bold ? bold[1].replace(/\s*·.*$/, "").trim() : "";
  const cover =
    rest.match(/background-image:\s*url\((['"]?)([^'")]+)\1\)/i)?.[2] ||
    rest.match(/<img[^>]+src="([^"]+)"/i)?.[1] ||
    "";
  return {
    appId,
    checked: match[1].toLowerCase() === "x",
    name,
    hours: parseHoursToken(rest),
    cover: cover && !isBannedCover(cover) ? cover : "",
    family: /Família/i.test(rest),
  };
}

function parseNoteGames(markdown) {
  const checked = new Set();
  const unchecked = new Set();
  const games = [];
  for (const raw of String(markdown || "").split(/\r?\n/)) {
    const row = parseTaskLine(raw);
    if (!row) continue;
    games.push(row);
    if (row.checked) checked.add(row.appId);
    else unchecked.add(row.appId);
  }
  return { checked, unchecked, games };
}

function parseDoneFromNote(markdown) {
  const parsed = parseNoteGames(markdown);
  return { checked: parsed.checked, unchecked: parsed.unchecked };
}

function backlogNotePaths(paths) {
  return [path.join(paths.root, "Backlog Steam.md"), paths.backlogNote];
}

function skippedNotePaths(paths) {
  return [path.join(paths.root, "Não vou jogar.md"), paths.skippedNote];
}

async function readNoteFiles(files) {
  const out = [];
  for (const file of files) {
    try {
      const st = await fs.stat(file);
      out.push({ file, text: await fs.readFile(file, "utf8"), mtime: st.mtimeMs });
    } catch {
      // nota ainda não existe
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

async function readBacklogNoteFiles(paths) {
  return readNoteFiles([...backlogNotePaths(paths), ...skippedNotePaths(paths)]);
}

async function loadDoneState(paths) {
  const stored = await readJson(paths.backlogDone, { appIds: [], games: {} });
  const doneIds = new Set((stored.appIds || []).map(Number).filter((id) => id > 0));
  const notes = await readBacklogNoteFiles(paths);
  for (const note of notes) {
    const parsed = parseDoneFromNote(note.text);
    for (const appId of parsed.checked) doneIds.add(appId);
    for (const appId of parsed.unchecked) doneIds.delete(appId);
  }
  return { doneIds, snapshots: stored.games || {} };
}

function snapshotGame(game) {
  return {
    appId: Number(game.appId),
    name: game.name || `App ${game.appId}`,
    logo: isCommunityLogo(game.logo) ? game.logo : "",
    cover: game.cover && !isBannedCover(game.cover) ? game.cover : "",
    hours: gameHours(game),
    playtimeMinutes: Number(game.playtimeMinutes || Math.round(gameHours(game) * 60)),
    appType: game.appType || "",
    family: Boolean(game.family),
  };
}

function sortByHoursDesc(games) {
  return [...games].sort((a, b) => {
    const dh = gameHours(b) - gameHours(a);
    if (dh) return dh;
    return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
  });
}

function normalizeTracked(item, appId) {
  const hours =
    item?.hours != null && Number.isFinite(Number(item.hours))
      ? Number(item.hours)
      : item?.firstHours != null
        ? Number(item.firstHours)
        : gameHours(item);
  return {
    appId: Number(appId),
    name: item?.name || `App ${appId}`,
    addedAt: item?.addedAt || nowIso(),
    coverUrl: item?.coverUrl || item?.cover || "",
    firstHours: item?.firstHours != null ? Number(item.firstHours) : hours,
    hours,
    playtimeMinutes:
      item?.playtimeMinutes != null ? Number(item.playtimeMinutes) : Math.round((hours || 0) * 60),
    logo: item?.logo || "",
    appType: item?.appType || "",
    cover: item?.cover || item?.coverUrl || "",
    family: Boolean(item?.family),
  };
}

function readTrackedMap(raw) {
  const map = {};
  const bag = raw?.games;
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(bag)
      ? bag
      : bag && typeof bag === "object"
        ? Object.values(bag)
        : typeof raw === "object" && raw
          ? Object.values(raw).filter((item) => item && item.appId)
          : [];
  for (const item of rows) {
    const appId = Number(item?.appId);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    map[appId] = normalizeTracked(item, appId);
  }
  return map;
}

function upsertTracked(map, game) {
  const appId = Number(game.appId);
  if (!Number.isInteger(appId) || appId <= 0) return;
  const hours = game.hours != null && Number.isFinite(Number(game.hours)) ? Number(game.hours) : gameHours(game);
  const existing = map[appId];
  if (existing) {
    if (game.name && !isBareName(game.name)) existing.name = game.name;
    if (Number.isFinite(hours)) {
      existing.hours = hours;
      existing.playtimeMinutes = Math.round(hours * 60);
    }
    const cover = game.cover || game.coverUrl;
    if (cover && !isBannedCover(cover)) {
      existing.coverUrl = cover;
      existing.cover = cover;
    }
    if (game.family) existing.family = true;
    if (game.family === false && existing.hours > 0) existing.family = false;
    return;
  }
  map[appId] = normalizeTracked(
    {
      appId,
      name: game.name,
      addedAt: nowIso(),
      coverUrl: game.cover || game.coverUrl || "",
      firstHours: hours,
      hours,
      playtimeMinutes: Math.round((hours || 0) * 60),
      logo: game.logo || "",
      appType: game.appType || "",
      family: Boolean(game.family),
    },
    appId
  );
}

async function loadAndMergeTracked(paths, ownedGames, doneSnapshots) {
  const map = readTrackedMap(await readJson(paths.backlogTracked, { games: {} }));

  for (const note of await readBacklogNoteFiles(paths)) {
    for (const row of parseNoteGames(note.text).games) {
      upsertTracked(map, row);
    }
  }

  for (const snap of Object.values(doneSnapshots || {})) {
    if (snap?.appId) upsertTracked(map, snap);
  }

  for (const game of ownedGames || []) {
    const appId = Number(game.appId);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    if (map[appId]) {
      upsertTracked(map, game);
      continue;
    }
    if (isJunkGame(game)) continue;
    upsertTracked(map, game);
  }

  return map;
}

async function saveTracked(paths, map) {
  const games = {};
  for (const game of Object.values(map)) {
    games[String(game.appId)] = {
      appId: game.appId,
      name: game.name,
      addedAt: game.addedAt,
      coverUrl: game.coverUrl || game.cover || "",
      firstHours: game.firstHours,
      hours: game.hours,
      ...(game.family ? { family: true } : {}),
    };
  }
  await writeJson(paths.backlogTracked, {
    updatedAt: nowIso(),
    count: Object.keys(games).length,
    games,
  });
}

function splitTracked(map, doneIds) {
  const open = [];
  const done = [];
  for (const game of Object.values(map)) {
    const row = { ...game, cover: game.cover || game.coverUrl };
    if (doneIds.has(game.appId)) done.push(row);
    else open.push(row);
  }
  return { open: sortByHoursDesc(open), done: sortByHoursDesc(done) };
}

function splitBacklog(games, doneIds, snapshots) {
  const map = {};
  for (const game of games || []) upsertTracked(map, game);
  for (const snap of Object.values(snapshots || {})) {
    if (snap?.appId) upsertTracked(map, snap);
  }
  return splitTracked(map, doneIds);
}

function coverUrl(game) {
  if (game.cover && !isBannedCover(game.cover)) return game.cover;
  if (game.coverUrl && !isBannedCover(game.coverUrl)) return game.coverUrl;
  if (isCommunityLogo(game.logo)) return game.logo;
  return "";
}

function taskRow(game, checked) {
  const mark = checked ? "x" : " ";
  const name = mdEsc(game.name || `App ${game.appId}`);
  const src = coverUrl(game);
  const art = src
    ? `<img src="${esc(src)}" alt="">`
    : `<span class="gbd-cover-empty" aria-hidden="true"></span>`;
  return `- [${mark}] ${art} <strong>${name}</strong> ${hoursHtml(gameHours(game))}${familyHtml(game)} <!--app:${Number(game.appId)}-->`;
}

function backlogTaskRow(game) {
  const name = mdEsc(game.name || `App ${game.appId}`);
  const src = coverUrl(game);
  const safe = src ? String(src).replace(/'/g, "%27").replace(/"/g, "%22") : "";
  const style = src
    ? ` style="background-image:url('${safe}');background-size:132px 50px;background-repeat:no-repeat;background-position:left center;padding-left:142px"`
    : "";
  return `- [ ] <span class="gbd-item"${style}><strong>${name}</strong> ${hoursHtml(gameHours(game))}${familyHtml(game)}</span> <!--app:${Number(game.appId)}-->`;
}

function privacyMessage(payload) {
  const bits = [];
  const communityOk = payload?.source === "xml" || payload?.source === "api";
  if (!communityOk) {
    if (payload?.source === "local" && payload.games?.length) {
      bits.push("Horas deste PC. Biblioteca/família completa: **Detalhes dos jogos = Público**.");
    } else if (!payload?.games?.length) {
      bits.push("Biblioteca não veio. **Detalhes dos jogos = Público** ou chave no config.json.");
    }
  }
  if (!payload?.familyComplete) bits.push("Family Sharing ainda não entrou.");
  return bits.join(" ");
}

function sourceHint(payload) {
  const bits = [];
  if (payload?.source === "local") bits.push("fonte: Steam local neste PC");
  else if (payload?.source === "api") bits.push("fonte: API da Steam");
  else if (payload?.source === "xml") bits.push("fonte: perfil público");
  else bits.push("sem horas da Steam");
  if (payload?.familyCount) bits.push(`${payload.familyCount} da família`);
  else if (payload?.familyFound) bits.push("grupo família no PC");
  if (payload?.cacheExtra) bits.push(`+${payload.cacheExtra} do cache local`);
  return bits.join(" · ");
}

const HOUR_SHELVES = [
  { key: "h100", tone: "green", title: "Mais de 100 h", extra: "os que mais te consumiram", test: (h) => h >= 100 },
  { key: "h50", tone: "green", title: "50 a 100 h", extra: "já virou hábito", test: (h) => h >= 50 && h < 100 },
  { key: "h20", tone: "green", title: "20 a 50 h", extra: "bem avançados", test: (h) => h >= 20 && h < 50 },
  { key: "h10", tone: "green", title: "10 a 20 h", extra: "em andamento", test: (h) => h >= 10 && h < 20 },
  { key: "h1", tone: "red", title: "Menos de 10 h", extra: "só comecei", test: (h) => h > 0 && h < 10 },
  { key: "never", tone: "red", title: "Nunca jogado", extra: "zero horas neste PC", test: (h) => h <= 0 },
];

function groupByHours(games) {
  return HOUR_SHELVES.map((def) => {
    const items = games.filter((game) => def.test(gameHours(game)));
    const hours = items.reduce((sum, game) => sum + gameHours(game), 0);
    return { ...def, items, hours };
  }).filter((shelf) => shelf.items.length);
}

function shelfHead(shelf) {
  const count = `${shelf.items.length} jogo${shelf.items.length === 1 ? "" : "s"}`;
  const hoursBit = shelf.hours > 0 ? ` · ${formatHoursPlain(shelf.hours)} no total` : "";
  return `<div class="gbd-shelf gbd-shelf-${esc(shelf.key)}">
  <div class="gbd-shelf-copy">
    <div class="gbd-shelf-title">${esc(shelf.title)}</div>
    <div class="gbd-shelf-kicker">${esc(shelf.extra)}</div>
  </div>
  <div class="gbd-shelf-extra">${esc(count)}${esc(hoursBit)}</div>
</div>`;
}

function shelfHeadMd(shelf) {
  const count = `${shelf.items.length} jogo${shelf.items.length === 1 ? "" : "s"}`;
  const hoursBit = shelf.hours > 0 ? ` · ${formatHoursPlain(shelf.hours)} no total` : "";
  return `**${shelf.title}** · ${shelf.extra} · ${count}${hoursBit}`;
}

function asCallout(text) {
  return String(text)
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}

function headerCallout({ openCount, totalHours, never, payload, timezone, updatedAt }) {
  const hint = privacyMessage(payload);
  const lines = [
    `[Não vou jogar](obsidian://open?file=N%C3%A3o%20vou%20jogar) · [Wishlist](obsidian://open?file=Minha%20Wishlist%20Steam) · [Atualizar](steamwish://update) · ${badgeText(updatedAt, timezone)}`,
    "Marque um jogo e clique **Atualizar** para mandar para **Não vou jogar**.",
  ];
  if (hint) lines.push(hint);
  return `> [!info] Backlog Steam · ${openCount} jogos · ${formatHoursPlain(totalHours)} · ${never} nunca tocados\n>\n${asCallout(lines.join("\n"))}`;
}

function groupBox(tone, title, extra, shelves) {
  if (!shelves.length) return "";
  const kind = tone === "red" ? "danger" : "success";
  const inner = shelves
    .map((shelf) => `${shelfHeadMd(shelf)}\n${shelf.items.map((game) => backlogTaskRow(game)).join("\n")}`)
    .join("\n\n");
  return `> [!${kind}] ${title} · ${extra}\n>\n${asCallout(inner)}`;
}

function renderBacklog({ open = [], payload = {}, timezone, updatedAt }) {
  const shelves = groupByHours(open);
  const totalHours = open.reduce((sum, game) => sum + gameHours(game), 0);
  const never = open.filter((game) => gameHours(game) <= 0).length;
  const played = shelves.filter((shelf) => shelf.tone === "green");
  const leftover = shelves.filter((shelf) => shelf.tone === "red");
  const playedCount = played.reduce((sum, shelf) => sum + shelf.items.length, 0);
  const leftoverCount = leftover.reduce((sum, shelf) => sum + shelf.items.length, 0);
  const playedHours = played.reduce((sum, shelf) => sum + shelf.hours, 0);
  const leftoverHours = leftover.reduce((sum, shelf) => sum + shelf.hours, 0);
  const body =
    [
      groupBox(
        "green",
        "10 h ou mais",
        `${playedCount} jogo${playedCount === 1 ? "" : "s"} · ${formatHoursPlain(playedHours)} no total`,
        played
      ),
      groupBox(
        "red",
        "Menos de 10 h",
        leftoverHours > 0
          ? `${leftoverCount} jogo${leftoverCount === 1 ? "" : "s"} · ${formatHoursPlain(leftoverHours)} jogadas · ${never} nunca tocados`
          : `${leftoverCount} jogo${leftoverCount === 1 ? "" : "s"} · ${never} nunca tocados`,
        leftover
      ),
    ]
      .filter(Boolean)
      .join("\n\n") || "_Nenhum jogo na biblioteca ainda._";

  return `---
cssclasses:
  - game-backlog-dashboard
tags:
  - dashboard
  - steam
  - backlog
---

${headerCallout({
  openCount: open.length,
  totalHours,
  never,
  payload,
  timezone,
  updatedAt,
})}

${body}
`;
}

function renderSkipped({ done = [], timezone, updatedAt }) {
  const list = done.map((game) => taskRow(game, true)).join("\n") || "_Nenhum jogo marcado._";

  return `---
cssclasses:
  - game-backlog-skipped
tags:
  - dashboard
  - steam
  - backlog
---

<div class="gbd-root">
  <div class="gbd-top">
    <div class="gbd-title">Não vou jogar <b>${done.length}</b></div>
    <div class="gbd-actions">
      <span class="gbd-pill">${esc(badgeText(updatedAt, timezone))}</span>
      <a class="gbd-nav" href="obsidian://open?file=Backlog%20Steam">Backlog</a>
      <a class="gbd-nav" href="obsidian://open?file=Minha%20Wishlist%20Steam">Wishlist</a>
      <a class="gbd-update" href="steamwish://update">Atualizar</a>
    </div>
  </div>
  <div class="gbd-counts">Não vou jogar <b>${done.length}</b></div>
  <div class="gbd-hint">Desmarque e clique <b>Atualizar</b> para devolver o jogo ao Backlog. Esta lista não apaga o jogo da biblioteca.</div>
</div>

${list}
`;
}

async function writeNoteCopies(files, markdown) {
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, markdown, "utf8");
  }
}

async function saveDoneState(paths, doneGames) {
  const games = {};
  const appIds = [];
  for (const game of doneGames) {
    appIds.push(game.appId);
    games[String(game.appId)] = snapshotGame(game);
  }
  await writeJson(paths.backlogDone, {
    updatedAt: nowIso(),
    appIds,
    games,
  });
  try {
    const { mirrorBacklogFiles } = require("./userBackup");
    await mirrorBacklogFiles(paths, { allowEmpty: true });
  } catch {
    // espelho no AppData não pode quebrar a marcação
  }
}

async function resolveMissingNames(games, config, cachePath) {
  const cache = await readJson(cachePath, { names: {} });
  const names = cache.names || {};
  let resolved = 0;

  for (const game of games) {
    const cached = names[String(game.appId)];
      if (cached?.name && !isBareName(cached.name)) {
        game.name = cached.name;
        if (isCommunityLogo(cached.logo) && !game.logo) game.logo = cached.logo;
      }
  }

  const missing = sortByHoursDesc(games.filter((game) => isBareName(game.name)));
  for (const game of missing) {
    if (resolved >= NAME_RESOLVE_LIMIT) break;
    try {
      const details = await fetchAppDetails(game.appId, {
        country: config.country,
        language: config.language,
        retries: 1,
        timeoutMs: 8000,
      });
      resolved += 1;
      if (details?.name && !details.unavailable && !isBareName(details.name)) {
        game.name = details.name;
        names[String(game.appId)] = { name: game.name, logo: "" };
      }
    } catch {
      break;
    }
  }

  await writeJson(cachePath, { updatedAt: nowIso(), names });
  return games;
}

async function refreshBacklog({
  config,
  steamId64 = null,
  ownedPayload = null,
  doneIdsOverride = null,
  onProgress,
} = {}) {
  const { paths } = config;
  const report = (current, total, label) => {
    if (typeof onProgress === "function") {
      try {
        onProgress({ current, total: Math.max(1, total), label: label || "backlog" });
      } catch {
        // progress hooks must not break backlog refresh
      }
    }
  };
  report(0, 1, "backlog");
  await fs.mkdir(paths.data, { recursive: true });
  await fs.mkdir(paths.dashboard, { recursive: true });

  let payload = ownedPayload;
  if (!payload && steamId64) {
    payload = await fetchOwnedPlaytimes(steamId64, { apiKey: config.steamWebApiKey });
  }
  if (!payload) {
    payload = await readJson(paths.ownedPlaytimes, {
      games: [],
      source: "none",
      communityPrivate: true,
    });
  } else {
    await writeJson(paths.ownedPlaytimes, {
      updatedAt: nowIso(),
      source: payload.source,
      communityPrivate: Boolean(payload.communityPrivate),
      familyFound: Boolean(payload.familyFound),
      familyComplete: Boolean(payload.familyComplete),
      familyCount: Number(payload.familyCount || 0),
      cacheExtra: Number(payload.cacheExtra || 0),
      count: (payload.games || []).length,
      games: payload.games || [],
    });
  }

  let doneIds;
  let snapshots;
  if (doneIdsOverride) {
    const stored = await readJson(paths.backlogDone, { appIds: [], games: {} });
    doneIds = new Set([...doneIdsOverride].map(Number).filter((id) => id > 0));
    snapshots = stored.games || {};
  } else {
    ({ doneIds, snapshots } = await loadDoneState(paths));
  }
  await writeJson(paths.backlogDone, {
    updatedAt: nowIso(),
    appIds: [...doneIds],
    games: snapshots,
  });

  const nameCache = path.join(paths.data, "appNames.json");
  const catalog = await resolveMissingNames(
    (payload.games || []).map((game) => snapshotGame(game)),
    config,
    nameCache
  );
  const tracked = await loadAndMergeTracked(paths, catalog, snapshots);
  await saveTracked(paths, tracked);
  const { open, done } = splitTracked(tracked, doneIds);
  const coverGames = [...open, ...done];
  await resolveCovers(coverGames, path.join(paths.data, "backlogCovers.json"), config, {
    retryFailed: true,
    onProgress: (current, total) => report(current, total, "capas"),
  });
  report(1, 1, "capas");
  await fillLibraryReviews(config, coverGames, {
    onProgress: (current, total) => report(current, total, "reviews"),
  });
  report(1, 1, "reviews");

  const updatedAt = nowIso();
  await writeNoteCopies(
    backlogNotePaths(paths),
    renderBacklog({
      open,
      payload,
      timezone: config.timezone,
      updatedAt,
    })
  );
  await writeNoteCopies(
    skippedNotePaths(paths),
    renderSkipped({
      done,
      timezone: config.timezone,
      updatedAt,
    })
  );
  await saveDoneState(paths, done);
  return { open, done, payload, updatedAt };
}

function attachReviews(games, cache) {
  const map = cache?.games && typeof cache.games === "object" ? cache.games : {};
  for (const game of games || []) {
    const hit = map[String(game.appId)];
    if (!hit) continue;
    if (hit.percent != null && Number.isFinite(Number(hit.percent))) {
      game.reviewPercent = Number(hit.percent);
    }
    game.reviewTotal = Number(hit.total) || 0;
  }
}

async function fillLibraryReviews(config, games, options = {}) {
  const file = config?.paths?.libraryReviews;
  if (!file) return false;
  const cache = await readJson(file, { games: {} });
  if (!cache.games || typeof cache.games !== "object") cache.games = {};
  const now = Date.now();
  const stale = (games || []).filter((game) => {
    const id = Number(game?.appId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const hit = cache.games[String(id)];
    if (!hit || !hit.fetchedAt) return true;
    const age = now - Date.parse(hit.fetchedAt);
    return !Number.isFinite(age) || age > REVIEW_TTL_MS;
  });
  const batch = stale.slice(0, Number(options.limit) || REVIEW_BATCH);
  if (!batch.length) {
    attachReviews(games, cache);
    return false;
  }
  const report = typeof options.onProgress === "function" ? options.onProgress : () => {};
  let changed = false;
  await mapPool(batch, 4, async (game) => {
    const reviews = await fetchReviews(game.appId);
    const failed = reviews.reviewPercent == null && reviews.reviewTotal == null;
    if (failed) return;
    cache.games[String(game.appId)] = {
      percent: reviews.reviewPercent,
      total: reviews.reviewTotal || 0,
      fetchedAt: nowIso(),
    };
    changed = true;
  }, (done, total) => report(done, total));
  if (changed) {
    cache.updatedAt = nowIso();
    await writeJson(file, cache);
  }
  attachReviews(games, cache);
  return changed;
}

function publicGame(game) {
  const id = Number(game.appId);
  const covers = coverCandidates(game, coverUrl(game));
  return {
    appId: id,
    name: game.name || `App ${id}`,
    cover: coverUrl(game) || covers[0] || "",
    covers,
    hours: gameHours(game),
    family: Boolean(game.family),
    storeUrl: `https://store.steampowered.com/app/${id}`,
    reviewPercent: game.reviewPercent != null && Number.isFinite(Number(game.reviewPercent)) ? Number(game.reviewPercent) : null,
    reviewTotal: Number(game.reviewTotal) || 0,
  };
}

async function loadLibraryLists(config) {
  const { paths } = config;
  const tracked = readTrackedMap(await readJson(paths.backlogTracked, { games: {} }));
  const { doneIds, snapshots } = await loadDoneState(paths);
  for (const snap of Object.values(snapshots || {})) {
    if (snap?.appId) upsertTracked(tracked, snap);
  }
  const { open, done } = splitTracked(tracked, doneIds);
  const coverPath = path.join(paths.data, "backlogCovers.json");
  const all = [...open, ...done];
  attachCachedCovers(all, readCoverMap(await readJson(coverPath, {})));
  const missing = all.filter((game) => !coverUrl(game));
  if (missing.length) {
    await resolveCovers(missing, coverPath, config);
    attachCachedCovers(all, readCoverMap(await readJson(coverPath, {})));
  }
  attachReviews(all, await readJson(paths.libraryReviews, { games: {} }));
  const payload = await readJson(paths.ownedPlaytimes, {
    games: [],
    source: "none",
    communityPrivate: true,
  });
  return {
    open: open.map(publicGame),
    done: done.map(publicGame),
    meta: {
      source: payload.source || "none",
      familyComplete: Boolean(payload.familyComplete),
      familyCount: Number(payload.familyCount || 0),
      hint: privacyMessage(payload).replace(/\*\*/g, ""),
      sourceHint: sourceHint(payload),
    },
  };
}

async function toggleSkipped(config, appId, skipped) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) {
    return loadLibraryLists(config);
  }
  const { paths } = config;
  const { doneIds, snapshots } = await loadDoneState(paths);
  if (skipped) doneIds.add(id);
  else doneIds.delete(id);
  const tracked = await loadAndMergeTracked(paths, [], snapshots);
  const { open, done } = splitTracked(tracked, doneIds);
  attachCachedCovers(
    [...open, ...done],
    readCoverMap(await readJson(path.join(paths.data, "backlogCovers.json"), {}))
  );
  await saveDoneState(paths, done);
  const payload = await readJson(paths.ownedPlaytimes, { games: [], source: "none" });
  const updatedAt = nowIso();
  await writeNoteCopies(
    backlogNotePaths(paths),
    renderBacklog({
      open,
      payload,
      timezone: config.timezone,
      updatedAt,
    })
  );
  await writeNoteCopies(
    skippedNotePaths(paths),
    renderSkipped({
      done,
      timezone: config.timezone,
      updatedAt,
    })
  );
  return loadLibraryLists(config);
}

module.exports = {
  refreshBacklog,
  renderBacklog,
  renderSkipped,
  splitBacklog,
  parseDoneFromNote,
  gameHours,
  loadLibraryLists,
  toggleSkipped,
  fillLibraryReviews,
  coverCandidates,
  coverUrl,
  defaultCapsule,
  attachCachedCovers,
  resolveCovers,
  isBannedCover,
};
