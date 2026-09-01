/**
 * Painel arrastável: Novidades, Loja e Jogos.
 * Wishlist e Backlog não usam isto.
 */
(function (global) {
  const STORAGE = "mld.boardLayout";
  const COLS = 12;
  const ROW = 20;
  const MIN_W = 2;
  const MAX_W = 12;
  const MIN_H = 4;
  const MAX_H = 60;

  const DEFAULTS = {
    novidades: {
      patches: { i: 0, w: 6, h: 22 },
      news: { i: 1, w: 6, h: 22 },
      promos: { i: 2, w: 12, h: 16 },
    },
    loja: {
      wanted: { i: 0, w: 12, h: 15 },
      popular: { i: 1, w: 12, h: 15 },
      steam: { i: 2, w: 12, h: 15 },
      newdeals: { i: 3, w: 6, h: 24 },
      bestdeals: { i: 4, w: 6, h: 24 },
    },
    jogos: {
      h100: { i: 0, w: 12, h: 16 },
      h50: { i: 1, w: 12, h: 16 },
      h20: { i: 2, w: 12, h: 16 },
      h10: { i: 3, w: 12, h: 16 },
      h1: { i: 4, w: 12, h: 16 },
      never: { i: 5, w: 12, h: 16 },
    },
  };

  let store = readLocal();
  let persistTimer = 0;
  let drag = null;
  let resize = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  function boardMap(boardId) {
    const base = clone(DEFAULTS[boardId] || {});
    const extra = store[boardId] && typeof store[boardId] === "object" ? store[boardId] : {};
    const out = {};
    for (const [id, def] of Object.entries(base)) {
      const hit = extra[id] && typeof extra[id] === "object" ? extra[id] : {};
      out[id] = {
        i: Number.isFinite(Number(hit.i)) ? Number(hit.i) : def.i,
        w: clamp(Number(hit.w) || def.w, MIN_W, MAX_W),
        h: clamp(Number(hit.h) || def.h, MIN_H, MAX_H),
      };
    }
    for (const [id, hit] of Object.entries(extra)) {
      if (out[id] || !hit || typeof hit !== "object") continue;
      out[id] = {
        i: Number(hit.i) || 99,
        w: clamp(Number(hit.w) || 12, MIN_W, MAX_W),
        h: clamp(Number(hit.h) || 16, MIN_H, MAX_H),
      };
    }
    return out;
  }

  function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, Math.round(x)));
  }

  function writeBoard(boardId, map) {
    store = { ...store, [boardId]: map };
    try {
      localStorage.setItem(STORAGE, JSON.stringify(store));
    } catch {
      // quota
    }
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      if (global.steamApp && typeof global.steamApp.saveSettings === "function") {
        global.steamApp.saveSettings({ layout: store }).catch(() => {});
      }
    }, 500);
  }

  function mergeFromServer(layout) {
    if (!layout || typeof layout !== "object") return;
    const localEmpty = !Object.keys(store).length;
    if (localEmpty) {
      store = clone(layout);
      try {
        localStorage.setItem(STORAGE, JSON.stringify(store));
      } catch {
        // ignore
      }
    }
  }

  function chromeFor(tile) {
    if (tile.querySelector(":scope > .board-chrome")) return;
    const head =
      tile.querySelector(":scope > .gwd-updates-col-head") ||
      tile.querySelector(":scope > .gwd-sechead") ||
      tile.querySelector(":scope > .lib-group-head") ||
      tile.querySelector(":scope > .lib-shelf") ||
      tile.querySelector(":scope > .board-title");
    const leftovers = [...tile.childNodes].filter((node) => node !== head);
    tile.replaceChildren();
    const chrome = document.createElement("div");
    chrome.className = "board-chrome";
    chrome.title = "Arraste para mudar a ordem";
    const grip = document.createElement("span");
    grip.className = "board-drag";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⋮⋮";
    chrome.appendChild(grip);
    if (head) chrome.appendChild(head);
    tile.appendChild(chrome);
    const body = document.createElement("div");
    body.className = "board-body";
    leftovers.forEach((node) => body.appendChild(node));
    tile.appendChild(body);
    const resizeBtn = document.createElement("button");
    resizeBtn.type = "button";
    resizeBtn.className = "board-resize";
    resizeBtn.title = "Redimensionar";
    resizeBtn.setAttribute("aria-label", "Redimensionar seção");
    tile.appendChild(resizeBtn);
  }

  function applyTileBox(tile, box) {
    tile.style.setProperty("--bw", String(box.w));
    tile.style.setProperty("--bh", String(box.h));
    tile.style.removeProperty("order");
  }

  function tilesOf(grid) {
    return [...grid.querySelectorAll(":scope > [data-board-tile]")];
  }

  function collectTiles(root) {
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    root.querySelectorAll(":scope > [data-board-tile]").forEach(add);
    const grid = root.querySelector(":scope > .board-grid");
    if (grid) grid.querySelectorAll(":scope > [data-board-tile]").forEach(add);
    return out;
  }

  function syncOrder(grid, boardId) {
    const map = boardMap(boardId);
    tilesOf(grid).forEach((tile, index) => {
      const id = tile.getAttribute("data-board-tile");
      if (!map[id]) map[id] = { i: index, w: 12, h: 16 };
      map[id].i = index;
    });
    writeBoard(boardId, map);
  }

  function ensureHint(root, boardId) {
    if (root.querySelector(":scope > .board-toolbar")) return;
    const bar = document.createElement("div");
    bar.className = "board-toolbar";
    bar.innerHTML = `<p class="board-hint">Arraste o <b>título</b> da seção (como a barra de um navegador). Puxe o canto para o tamanho. Jogos e links dentro da lista continuam clicáveis.</p>
      <div class="board-toolbar-actions">
        <button type="button" class="board-reset">Layout padrão</button>
      </div>`;
    const after =
      root.querySelector(":scope > .lib-meta") ||
      root.querySelector(":scope > .gwd-updates-hint") ||
      root.querySelector(":scope > .gwd-updates-head");
    if (after && after.nextSibling) root.insertBefore(bar, after.nextSibling);
    else if (after) after.after(bar);
    else root.insertBefore(bar, root.firstChild);
    bar.querySelector(".board-reset").addEventListener("click", (event) => {
      event.preventDefault();
      store = { ...store, [boardId]: clone(DEFAULTS[boardId] || {}) };
      try {
        localStorage.setItem(STORAGE, JSON.stringify(store));
      } catch {
        // ignore
      }
      apply(root, boardId);
      if (global.steamApp && typeof global.steamApp.saveSettings === "function") {
        global.steamApp.saveSettings({ layout: store }).catch(() => {});
      }
    });
  }

  function apply(root, boardId) {
    if (!root) return;
    const tiles = collectTiles(root);
    if (!tiles.length) return;
    root.classList.add("is-board");
    root.setAttribute("data-board", boardId);
    ensureHint(root, boardId);
    let grid = root.querySelector(":scope > .board-grid");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "board-grid";
      root.appendChild(grid);
    }
    const map = boardMap(boardId);
    const sorted = tiles.sort((a, b) => {
      const ia = map[a.getAttribute("data-board-tile")]?.i ?? 99;
      const ib = map[b.getAttribute("data-board-tile")]?.i ?? 99;
      return ia - ib;
    });
    for (const tile of sorted) {
      tile.classList.add("board-tile");
      chromeFor(tile);
      const id = tile.getAttribute("data-board-tile");
      const box = map[id] || { i: 99, w: 12, h: 16 };
      applyTileBox(tile, box);
      grid.appendChild(tile);
    }
    root.querySelectorAll(".gwd-updates-cols, .gwd-deals-cols").forEach((wrap) => {
      if (!wrap.querySelector("[data-board-tile]")) wrap.remove();
    });
    const sticky = new Set(
      [
        grid,
        root.querySelector(":scope > .board-toolbar"),
        root.querySelector(":scope > .gwd-updates-head"),
        root.querySelector(":scope > .gwd-updates-hint"),
        root.querySelector(":scope > .lib-meta"),
      ].filter(Boolean)
    );
    [...root.children]
      .filter((el) => !sticky.has(el) && !el.hasAttribute("data-board-tile"))
      .forEach((el) => root.appendChild(el));
    bindGrid(grid, boardId);
  }

  function bindGrid(grid, boardId) {
    if (grid.dataset.boardBound) return;
    grid.dataset.boardBound = "1";
    grid.addEventListener("pointerdown", (event) => {
      const grip = event.target.closest(".board-resize");
      const tile = event.target.closest("[data-board-tile]");
      if (!tile || !grid.contains(tile)) return;
      if (grip) {
        event.preventDefault();
        startResize(grid, boardId, tile, event);
        return;
      }
      if (shouldStartDrag(event, tile)) {
        event.preventDefault();
        startDrag(grid, boardId, tile, event);
      }
    });
  }

  function shouldStartDrag(event, tile) {
    if (event.button != null && event.button !== 0) return false;
    if (event.target.closest(".board-resize, .board-reset")) return false;
    if (event.target.closest("a, input, select, textarea, label")) return false;
    if (event.target.closest("button")) return false;
    if (event.target.closest(".lib-card, .lib-grid, .lib-drop-hint, .lib-add-list, .lib-sort, [data-list-del], [data-list-edit], [data-unpin], [data-list-sort]")) {
      return false;
    }
    return Boolean(
      event.target.closest(".board-chrome") ||
        event.target.closest(".board-drag") ||
        event.target === tile
    );
  }

  function startDrag(grid, boardId, tile, event) {
    tilesOf(grid).forEach((el) => el.style.removeProperty("order"));
    const rect = tile.getBoundingClientRect();
    drag = {
      grid,
      boardId,
      tile,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
      ghost: null,
      pointer: event.pointerId,
    };
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragEnd, true);
    window.addEventListener("pointercancel", onDragEnd, true);
    try {
      tile.setPointerCapture?.(event.pointerId);
    } catch {
      // pointer sintético
    }
  }

  function ensureGhost() {
    if (!drag || drag.ghost) return;
    const rect = drag.tile.getBoundingClientRect();
    const ghost = drag.tile.cloneNode(true);
    ghost.classList.add("board-ghost");
    ghost.removeAttribute("data-board-tile");
    ghost.style.cssText = [
      "position:fixed",
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      "margin:0",
      "z-index:80",
      "pointer-events:none",
      "opacity:0.9",
      "box-shadow:0 12px 32px #0008",
    ].join(";");
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.tile.classList.add("is-dragging");
  }

  function hitTile(grid, x, y, skip) {
    const stack = document.elementsFromPoint(x, y) || [];
    for (const el of stack) {
      if (el.classList?.contains("board-ghost")) continue;
      const tile = el.closest?.("[data-board-tile]");
      if (tile && tile !== skip && grid.contains(tile)) return tile;
    }
    const list = tilesOf(grid);
    let best = null;
    let bestD = Infinity;
    for (const el of list) {
      if (el === skip) continue;
      const box = el.getBoundingClientRect();
      const d = Math.hypot(x - (box.left + box.width / 2), y - (box.top + box.height / 2));
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return bestD < 420 ? best : null;
  }

  function placeTile(grid, tile, over, x, y) {
    if (!over || over === tile) return;
    const box = over.getBoundingClientRect();
    const afterX = x > box.left + box.width / 2;
    const afterY = y > box.top + box.height / 2;
    const useX = Math.abs(x - (box.left + box.width / 2)) >= Math.abs(y - (box.top + box.height / 2));
    const after = useX ? afterX : afterY;
    if (after) grid.insertBefore(tile, over.nextSibling);
    else grid.insertBefore(tile, over);
  }

  function onDragMove(event) {
    if (!drag) return;
    const dist = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && dist < 8) return;
    drag.moved = true;
    event.preventDefault();
    ensureGhost();
    if (drag.ghost) {
      drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
      drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
    }
    const over = hitTile(drag.grid, event.clientX, event.clientY, drag.tile);
    if (over) placeTile(drag.grid, drag.tile, over, event.clientX, event.clientY);
  }

  function onDragEnd() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    drag.tile.classList.remove("is-dragging");
    if (drag.moved) syncOrder(drag.grid, drag.boardId);
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragEnd, true);
    window.removeEventListener("pointercancel", onDragEnd, true);
    drag = null;
  }

  function startResize(grid, boardId, tile, event) {
    const map = boardMap(boardId);
    const id = tile.getAttribute("data-board-tile");
    const box = map[id] || { i: 0, w: 12, h: 16 };
    resize = {
      grid,
      boardId,
      tile,
      id,
      map,
      startX: event.clientX,
      startY: event.clientY,
      w: box.w,
      h: box.h,
      cellW: Math.max(24, grid.clientWidth / COLS),
    };
    tile.classList.add("is-resizing");
    window.addEventListener("pointermove", onResizeMove, true);
    window.addEventListener("pointerup", onResizeEnd, true);
    window.addEventListener("pointercancel", onResizeEnd, true);
    try {
      tile.setPointerCapture?.(event.pointerId);
    } catch {
      // pointer sintético / captura já solta
    }
  }

  function onResizeMove(event) {
    if (!resize) return;
    const dw = Math.round((event.clientX - resize.startX) / resize.cellW);
    const dh = Math.round((event.clientY - resize.startY) / ROW);
    const w = clamp(resize.w + dw, MIN_W, MAX_W);
    const h = clamp(resize.h + dh, MIN_H, MAX_H);
    resize.map[resize.id] = { ...(resize.map[resize.id] || {}), w, h, i: resize.map[resize.id]?.i ?? 0 };
    applyTileBox(resize.tile, resize.map[resize.id]);
  }

  function onResizeEnd() {
    if (!resize) return;
    resize.tile.classList.remove("is-resizing");
    writeBoard(resize.boardId, resize.map);
    window.removeEventListener("pointermove", onResizeMove, true);
    window.removeEventListener("pointerup", onResizeEnd, true);
    window.removeEventListener("pointercancel", onResizeEnd, true);
    resize = null;
  }

  global.layoutBoard = {
    apply,
    mergeFromServer,
    defaults: DEFAULTS,
  };
})(window);
