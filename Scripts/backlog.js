/**
 * Backlog: biblioteca Steam inteira (sem corte de horas).
 * Atualizar só adiciona compras novas. Tarefas Markdown (- [ ] / - [x]) gravam sozinhas.
 */

const fs = require("fs/promises");
const path = require("path");
const { readJson, writeJson, nowIso } = require("./config");
const { fetchOwnedPlaytimes, fetchAppDetails, mapPool } = require("./steamApi");

const NAME_RESOLVE_LIMIT = 15;
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

function hoursHtml(hours) {
  if (!hours || hours <= 0) {
    return `<span class="gwd-bl-never" style="color:#ff6b6b;font-weight:650">Nunca jogado</span>`;
  }
  return `<span class="gwd-bl-hours" style="color:#4da3ff;font-weight:650">${esc(formatHours(hours))}</span>`;
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
  if (cached && !isBannedCover(cached)) list.push(cached);
  list.push(defaultCapsule(id));
  list.push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_231x87.jpg`);
  list.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`);
  list.push(`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`);
  if (game.logoHash) {
    list.push(`https://media.steampowered.com/steamcommunity/public/images/apps/${id}/${game.logoHash}.jpg`);
  }
  if (isCommunityLogo(game.logo)) list.push(game.logo);
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

function readCoverMap(raw) {
  const source = raw?.urls && typeof raw.urls === "object" ? raw.urls : raw || {};
  const urls = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^\d+$/.test(key) || !value || isBannedCover(value)) continue;
    urls[key] = String(value);
  }
  return urls;
}

async function resolveCovers(games, cachePath) {
  const urls = readCoverMap(await readJson(cachePath, {}));
  const legacy = readCoverMap(await readJson(path.join(path.dirname(cachePath), "coverUrls.json"), {}));
  for (const [key, value] of Object.entries(legacy)) {
    if (!urls[key]) urls[key] = value;
  }

  await mapPool(games, 8, async (game) => {
    const cached = urls[String(game.appId)];
    if (cached && !isBannedCover(cached)) {
      game.cover = cached;
      return;
    }
    for (const candidate of coverCandidates(game, cached)) {
      if (await headOk(candidate)) {
        game.cover = candidate;
        urls[String(game.appId)] = candidate;
        return;
      }
    }
    game.cover = "";
  });

  await writeJson(cachePath, urls);
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
  const bold = rest.match(/\*\*(.+?)\*\*/);
  const name = bold ? bold[1].replace(/\s*·.*$/, "").trim() : "";
  const cover = rest.match(/<img[^>]+src="([^"]+)"/i)?.[1] || "";
  return {
    appId,
    checked: match[1].toLowerCase() === "x",
    name,
    hours: parseHoursToken(rest),
    cover: cover && !isBannedCover(cover) ? cover : "",
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
  return `- [${mark}] ${art} **${name}** ${hoursHtml(gameHours(game))} <!--app:${Number(game.appId)}-->`;
}

function privacyMessage(payload) {
  if (payload?.source === "xml" || payload?.source === "api") return "";
  if (payload?.source === "local" && payload.games?.length) {
    return "Horas lidas do Steam **neste PC**. O perfil ainda está com Detalhes dos jogos privado — jogos nunca abertos podem faltar. Perfil → Privacidade → **Detalhes dos jogos = Público** (wishlist pública não basta).";
  }
  return "A Steam não entregou as horas jogadas. Perfil → Privacidade → **Detalhes dos jogos = Público**. Wishlist pública não basta. Sem isso não dá para montar o backlog.";
}

function sourceHint(payload) {
  if (payload?.source === "local") return "fonte: Steam local neste PC";
  if (payload?.source === "api") return "fonte: API da Steam";
  if (payload?.source === "xml") return "fonte: perfil público";
  return "sem horas da Steam";
}

function renderBacklog({ open = [], payload = {}, timezone, updatedAt }) {
  const hint = privacyMessage(payload);
  const list = open.map((game) => taskRow(game, false)).join("\n") || "_Nenhum jogo na biblioteca ainda._";

  return `---
cssclasses:
  - game-backlog-dashboard
tags:
  - dashboard
  - steam
  - backlog
---

<div class="gbd-root">
  <div class="gbd-top">
    <div class="gbd-title">🎮 Backlog Steam</div>
    <div class="gbd-actions">
      <span class="gbd-pill">${esc(badgeText(updatedAt, timezone))}</span>
      <a class="gbd-nav" href="obsidian://open?file=N%C3%A3o%20vou%20jogar">Não vou jogar</a>
      <a class="gbd-nav" href="obsidian://open?file=Minha%20Wishlist%20Steam">Wishlist</a>
      <a class="gbd-update" href="steamwish://update">Atualizar</a>
    </div>
  </div>
  <div class="gbd-counts">Na lista: <b>${open.length}</b></div>
  <div class="gbd-hint">Biblioteca inteira. <b>Marque e clique Atualizar</b> (ou o botão) para mandar para <b>Não vou jogar</b>. Atualizar só adiciona compras novas — nada some por horas jogadas. ${esc(sourceHint(payload))}</div>
  ${hint ? `<div class="gbd-warn">${esc(hint).replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")}</div>` : ""}
</div>

${list}
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
} = {}) {
  const { paths } = config;
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
  await resolveCovers([...open, ...done], path.join(paths.data, "backlogCovers.json"));

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

module.exports = {
  refreshBacklog,
  renderBacklog,
  renderSkipped,
  splitBacklog,
  parseDoneFromNote,
  gameHours,
};
