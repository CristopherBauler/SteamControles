/**
 * Listas moldáveis na aba Jogos: nome, criar, apagar, arrastar jogos.
 * Sem pin, o jogo volta para a faixa de horas.
 */
(function (global) {
  const STORAGE = "mld.libraryLists";
  const DEFAULT_LISTS = [
    { id: "h100", title: "Mais de 100 h", extra: "os que mais te consumiram", tone: "green", auto: "h100" },
    { id: "h50", title: "50 a 100 h", extra: "já virou hábito", tone: "green", auto: "h50" },
    { id: "h20", title: "20 a 50 h", extra: "bem avançados", tone: "green", auto: "h20" },
    { id: "h10", title: "10 a 20 h", extra: "em andamento", tone: "green", auto: "h10" },
    { id: "h1", title: "Menos de 10 h", extra: "só comecei", tone: "red", auto: "h1" },
    { id: "never", title: "Nunca jogado", extra: "zero horas neste PC", tone: "red", auto: "never" },
  ];
  const SORTS = ["hours", "reviews", "name"];
  const NAME_COLLATOR = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
  const AUTO_TEST = {
    h100: (h) => h >= 100,
    h50: (h) => h >= 50 && h < 100,
    h20: (h) => h >= 20 && h < 50,
    h10: (h) => h >= 10 && h < 20,
    h1: (h) => h > 0 && h < 10,
    never: (h) => h <= 0,
  };

  let data = readLocal();
  let persistTimer = 0;
  let onChange = null;
  let cardDrag = null;
  let nativeDrag = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE) || "{}");
      return sanitize(raw);
    } catch {
      return { lists: clone(DEFAULT_LISTS), pins: {} };
    }
  }

  function sanitize(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const lists = Array.isArray(src.lists) && src.lists.length ? src.lists.map(cleanList).filter(Boolean) : clone(DEFAULT_LISTS);
    const pins = {};
    if (src.pins && typeof src.pins === "object") {
      for (const [id, listId] of Object.entries(src.pins)) {
        if (Number(id) > 0 && listId) pins[String(Number(id))] = String(listId);
      }
    }
    return { lists, pins };
  }

  function cleanList(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    if (!id) return null;
    const tone = item.tone === "red" ? "red" : "green";
    const auto = DEFAULT_LISTS.some((d) => d.auto === item.auto) ? item.auto : null;
    return {
      id,
      title: String(item.title || "Lista").slice(0, 80),
      extra: String(item.extra || "").slice(0, 120),
      tone,
      auto,
      sort: SORTS.includes(item.sort) ? item.sort : "hours",
    };
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(data));
    } catch {
      // quota
    }
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      if (global.steamApp && typeof global.steamApp.saveSettings === "function") {
        global.steamApp.saveSettings({ libraryLists: data }).catch(() => {});
      }
    }, 400);
  }

  function mergeFromServer(incoming) {
    if (!incoming || typeof incoming !== "object") return;
    const localEmpty =
      !Object.keys(data.pins || {}).length &&
      JSON.stringify(data.lists) === JSON.stringify(DEFAULT_LISTS);
    const has =
      (Array.isArray(incoming.lists) && incoming.lists.length) ||
      (incoming.pins && Object.keys(incoming.pins).length);
    if (localEmpty && has) data = sanitize(incoming);
  }

  function autoId(hours) {
    const h = Number(hours) || 0;
    for (const def of DEFAULT_LISTS) {
      if (AUTO_TEST[def.auto]?.(h)) return def.auto;
    }
    return "never";
  }

  function hoursOf(game) {
    return Number(game?.hours) || 0;
  }

  function reviewPercent(game) {
    const n = Number(game?.reviewPercent);
    return Number.isFinite(n) ? n : -1;
  }

  function sortItems(items, sort) {
    const list = [...(items || [])];
    if (sort === "name") {
      list.sort((a, b) => NAME_COLLATOR.compare(a.name || "", b.name || "") || Number(a.appId) - Number(b.appId));
    } else if (sort === "reviews") {
      list.sort((a, b) => {
        const pa = reviewPercent(a);
        const pb = reviewPercent(b);
        if (pb !== pa) return pb - pa;
        const ta = Number(a.reviewTotal) || 0;
        const tb = Number(b.reviewTotal) || 0;
        if (tb !== ta) return tb - ta;
        return NAME_COLLATOR.compare(a.name || "", b.name || "");
      });
    } else {
      list.sort((a, b) => hoursOf(b) - hoursOf(a) || NAME_COLLATOR.compare(a.name || "", b.name || ""));
    }
    return list;
  }

  function group(games) {
    if (leftoverWouldExist(games) && !data.lists.some((list) => list.id === "outros")) {
      data.lists.push({ id: "outros", title: "Outros", extra: "sem faixa automática", tone: "red", auto: null, sort: "hours" });
      persist();
    }
    const lists = clone(data.lists.length ? data.lists : DEFAULT_LISTS);
    const buckets = Object.fromEntries(lists.map((list) => [list.id, []]));
    for (const game of games || []) {
      const pin = data.pins[String(game.appId)];
      if (pin && buckets[pin]) {
        buckets[pin].push(game);
        continue;
      }
      const home = lists.find((list) => list.auto && list.auto === autoId(hoursOf(game)));
      if (home && buckets[home.id]) buckets[home.id].push(game);
      else if (buckets.outros) buckets.outros.push(game);
      else if (lists[0]) buckets[lists[0].id].push(game);
    }
    return lists
      .map((list) => {
        const items = sortItems(buckets[list.id] || [], list.sort || "hours");
        const hours = items.reduce((sum, game) => sum + hoursOf(game), 0);
        return { ...list, key: list.id, items, hours };
      })
      .filter((list) => list.items.length || !list.auto);
  }

  function leftoverWouldExist(games) {
    const lists = data.lists.length ? data.lists : DEFAULT_LISTS;
    return (games || []).some((game) => {
      const pin = data.pins[String(game.appId)];
      if (pin && lists.some((list) => list.id === pin)) return false;
      return !lists.some((list) => list.auto && list.auto === autoId(hoursOf(game)));
    });
  }

  function isPinned(appId) {
    return Boolean(data.pins[String(appId)]);
  }

  function pin(appId, listId) {
    const id = String(Number(appId));
    if (!Number(id) || !listId || !data.lists.some((list) => list.id === listId)) return;
    data.pins[id] = String(listId);
    persist();
    if (onChange) onChange();
  }

  function unpin(appId) {
    delete data.pins[String(Number(appId))];
    persist();
    if (onChange) onChange();
  }

  function rename(listId, title) {
    const list = data.lists.find((item) => item.id === listId);
    if (!list) return;
    const next = String(title || "").trim().slice(0, 80);
    if (!next) return;
    list.title = next;
    persist();
    if (onChange) onChange();
  }

  function addList() {
    const id = `c${Date.now().toString(36)}`;
    data.lists.push({
      id,
      title: "Nova lista",
      extra: "arraste jogos para cá",
      tone: "green",
      auto: null,
      sort: "hours",
    });
    persist();
    if (onChange) onChange();
    return id;
  }

  function setSort(listId, sort) {
    const list = data.lists.find((item) => item.id === listId);
    if (!list || !SORTS.includes(sort) || list.sort === sort) return;
    list.sort = sort;
    persist();
    if (onChange) onChange();
  }

  function removeList(listId) {
    if (data.lists.length <= 1) return;
    const list = data.lists.find((item) => item.id === listId);
    if (!list) return;
    data.lists = data.lists.filter((item) => item.id !== listId);
    for (const [appId, pinId] of Object.entries(data.pins)) {
      if (pinId === listId) delete data.pins[appId];
    }
    persist();
    if (onChange) onChange();
  }

  function ensureTools(root) {
    const bar = root.querySelector(":scope > .board-toolbar");
    if (!bar) return;
    const actions = bar.querySelector(".board-toolbar-actions") || bar;
    if (actions.querySelector(".lib-add-list")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lib-add-list";
    btn.textContent = "Nova lista";
    actions.appendChild(btn);
  }

  function bind(root, handlers) {
    if (handlers && typeof handlers.onChange === "function") onChange = handlers.onChange;
    if (!root || root.dataset.libBound) return;
    root.dataset.libBound = "1";
    root.addEventListener("click", (event) => {
      if (event.target.closest(".lib-add-list")) {
        event.preventDefault();
        addList();
        return;
      }
      const del = event.target.closest("[data-list-del]");
      if (del) {
        event.preventDefault();
        const id = del.getAttribute("data-list-del");
        if (data.lists.length <= 1) return;
        const list = data.lists.find((item) => item.id === id);
        const ok = global.confirm(`Remover a lista “${list?.title || id}”? Os jogos voltam para a faixa de horas.`);
        if (ok) removeList(id);
        return;
      }
      const unpinBtn = event.target.closest("[data-unpin]");
      if (unpinBtn) {
        event.preventDefault();
        unpin(unpinBtn.getAttribute("data-unpin"));
        return;
      }
      const edit = event.target.closest("[data-list-edit]");
      if (edit) {
        event.preventDefault();
        const id = edit.getAttribute("data-list-edit");
        const title = [...root.querySelectorAll(".lib-group-title")].find((el) => el.getAttribute("data-list-id") === id);
        if (title) startRename(title);
      }
    });
    root.addEventListener("change", (event) => {
      const sel = event.target.closest("[data-list-sort]");
      if (!sel || !root.contains(sel)) return;
      setSort(sel.getAttribute("data-list-sort"), sel.value);
    });
    root.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button != null && event.button !== 0) return;
        if (event.target.closest("input, button, select, .lib-group-title[contenteditable='true']")) return;
        const card = event.target.closest(".lib-card[data-app-id]");
        if (!card || !root.contains(card)) return;
        startCardDrag(root, card, event);
      },
      true
    );
    root.addEventListener(
      "dragstart",
      (event) => {
        const card = event.target.closest(".lib-card[data-app-id]");
        if (!card || !root.contains(card)) return;
        if (event.target.closest("input, button")) {
          event.preventDefault();
          return;
        }
        const appId = card.getAttribute("data-app-id");
        try {
          event.dataTransfer.setData("application/x-mld-app", appId);
          event.dataTransfer.setData("text/plain", appId);
          event.dataTransfer.effectAllowed = "move";
        } catch {
          // IE/old
        }
        card.classList.add("is-card-dragging");
        nativeDrag = { root, appId, fromList: card.closest("[data-board-tile]")?.getAttribute("data-board-tile") || "" };
        try {
          event.dataTransfer.setDragImage(card, Math.min(40, card.offsetWidth / 4), 20);
        } catch {
          // ignore
        }
      },
      true
    );
    root.addEventListener(
      "dragend",
      () => {
        nativeDrag = null;
        root.querySelectorAll(".is-card-dragging").forEach((el) => el.classList.remove("is-card-dragging"));
        root.querySelectorAll("[data-board-tile].is-drop").forEach((el) => el.classList.remove("is-drop"));
      },
      true
    );
    root.addEventListener(
      "dragenter",
      (event) => {
        const tile = hitListTile(root, event.target);
        if (!tile) return;
        event.preventDefault();
        markDrop(root, tile);
      },
      true
    );
    root.addEventListener(
      "dragover",
      (event) => {
        const tile = hitListTile(root, event.target);
        if (!tile) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        markDrop(root, tile);
      },
      true
    );
    root.addEventListener(
      "drop",
      (event) => {
        const tile = hitListTile(root, event.target);
        if (!tile) return;
        event.preventDefault();
        const appId = parseAppId(
          nativeDrag?.appId ||
            cardDrag?.appId ||
            (event.dataTransfer &&
              (event.dataTransfer.getData("application/x-mld-app") || event.dataTransfer.getData("text/plain")))
        );
        const listId = tile.getAttribute("data-board-tile");
        nativeDrag = null;
        if (appId && listId) pin(appId, listId);
      },
      true
    );
  }

  function parseAppId(value) {
    const direct = Number(value);
    if (direct > 0) return String(direct);
    const fromUrl = String(value || "").match(/\/app\/(\d+)/);
    return fromUrl ? fromUrl[1] : "";
  }

  function hitListTile(root, target) {
    const tile = target && target.closest ? target.closest("[data-board-tile]") : null;
    return tile && root.contains(tile) ? tile : null;
  }

  function markDrop(root, tile) {
    root.querySelectorAll("[data-board-tile].is-drop").forEach((el) => el.classList.remove("is-drop"));
    if (tile) tile.classList.add("is-drop");
  }

  function startRename(title) {
    title.contentEditable = "true";
    title.spellcheck = false;
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = () => {
      title.removeEventListener("blur", finish);
      title.removeEventListener("keydown", onKey);
      title.contentEditable = "false";
      rename(title.getAttribute("data-list-id"), title.textContent);
    };
    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        title.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        title.blur();
      }
    };
    title.addEventListener("blur", finish);
    title.addEventListener("keydown", onKey);
  }

  function startCardDrag(root, card, event) {
    const rect = card.getBoundingClientRect();
    cardDrag = {
      root,
      card,
      appId: card.getAttribute("data-app-id"),
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
      ghost: null,
      overList: "",
      fromList: card.closest("[data-board-tile]")?.getAttribute("data-board-tile") || "",
    };
    window.addEventListener("pointermove", onCardMove, true);
    window.addEventListener("pointerup", onCardEnd, true);
    window.addEventListener("pointercancel", onCardEnd, true);
  }

  function ensureCardGhost() {
    if (!cardDrag || cardDrag.ghost) return;
    const rect = cardDrag.card.getBoundingClientRect();
    const ghost = cardDrag.card.cloneNode(true);
    ghost.classList.add("lib-card-ghost");
    ghost.style.cssText = [
      "position:fixed",
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      "z-index:90",
      "pointer-events:none",
      "opacity:0.92",
      "margin:0",
    ].join(";");
    document.body.appendChild(ghost);
    cardDrag.ghost = ghost;
    cardDrag.card.classList.add("is-card-dragging");
  }

  function onCardMove(event) {
    if (!cardDrag) return;
    const dist = Math.hypot(event.clientX - cardDrag.startX, event.clientY - cardDrag.startY);
    if (!cardDrag.moved && dist < 8) return;
    cardDrag.moved = true;
    event.preventDefault();
    ensureCardGhost();
    if (cardDrag.ghost) {
      cardDrag.ghost.style.left = `${event.clientX - cardDrag.offsetX}px`;
      cardDrag.ghost.style.top = `${event.clientY - cardDrag.offsetY}px`;
    }
    const over = dropTarget(cardDrag.root, event.clientX, event.clientY, cardDrag.fromList);
    cardDrag.overList = over?.getAttribute("data-board-tile") || "";
    markDrop(cardDrag.root, over);
  }

  function dropTarget(root, x, y, skipListId) {
    const skipCard = cardDrag && cardDrag.card;
    const stack = (document.elementsFromPoint(x, y) || []).filter((el) => {
      if (el.classList?.contains("lib-card-ghost")) return false;
      if (skipCard && (el === skipCard || skipCard.contains(el))) return false;
      return true;
    });
    const pick = (preferOther) => {
      for (const el of stack) {
        const tile = el.closest?.("[data-board-tile]");
        if (!tile || !root.contains(tile)) continue;
        const id = tile.getAttribute("data-board-tile");
        if (preferOther && skipListId && id === skipListId) continue;
        return tile;
      }
      return null;
    };
    const other = pick(true);
    if (other) return other;
    const same = pick(false);
    if (same) return same;
    let best = null;
    let bestD = Infinity;
    root.querySelectorAll("[data-board-tile]").forEach((tile) => {
      const id = tile.getAttribute("data-board-tile");
      if (skipListId && id === skipListId) return;
      const box = tile.getBoundingClientRect();
      const d = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
      if (d < bestD) {
        bestD = d;
        best = tile;
      }
    });
    return bestD < 520 ? best : null;
  }

  function onCardEnd(event) {
    if (!cardDrag) return;
    const { root, moved, appId, ghost, card, fromList, overList } = cardDrag;
    const cancelled = event.type === "pointercancel";
    if (ghost) ghost.remove();
    card.classList.remove("is-card-dragging");
    const dropId =
      overList ||
      dropTarget(root, event.clientX, event.clientY, fromList)?.getAttribute("data-board-tile") ||
      "";
    root.querySelectorAll("[data-board-tile].is-drop").forEach((el) => el.classList.remove("is-drop"));
    window.removeEventListener("pointermove", onCardMove, true);
    window.removeEventListener("pointerup", onCardEnd, true);
    window.removeEventListener("pointercancel", onCardEnd, true);
    cardDrag = null;
    if (!moved) return;
    if (cancelled) return;
    event.preventDefault();
    const swallow = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      root.removeEventListener("click", swallow, true);
    };
    root.addEventListener("click", swallow, true);
    if (dropId && appId) pin(appId, dropId);
  }

  global.libraryBoard = {
    mergeFromServer,
    group,
    isPinned,
    ensureTools,
    bind,
    defaults: DEFAULT_LISTS,
  };
})(window);
