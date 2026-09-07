/**
 * Login Epic: sessão salva do launcher (com autorização) ou janela do site.
 */

const { BrowserWindow, dialog } = require("electron");
const {
  epicAuthUrl,
  parseEpicRedirectPayload,
  startEpicSession,
  exchangeSidForCode,
  probeEglSession,
  importEglSession,
  CLIENT_ID,
} = require("../Scripts/epicApi");

const REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;

function dialogParent(parent) {
  return parent && !parent.isDestroyed() ? parent : undefined;
}

async function chooseEpicLogin(parent, probe) {
  const name = probe.displayName ? ` (${probe.displayName})` : "";
  const result = await dialog.showMessageBox(dialogParent(parent), {
    type: "question",
    buttons: ["Usar o launcher da Epic", "Entrar no site da Epic", "Cancelar"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "Biblioteca da Epic",
    message: `O launcher da Epic neste PC está conectado${name}.`,
    detail:
      "Autorizar este app a usar essa sessão para listar a biblioteca da conta?\n\nA Epic só mantém um token. Se o launcher estiver aberto, feche e abra de novo depois — senão ele pode pedir login outra vez. A senha não passa por aqui.",
  });
  if (result.response === 2) throw new Error("Login da Epic cancelado.");
  return result.response === 0 ? "egl" : "web";
}

async function confirmEglImport(parent, probe) {
  const name = probe.displayName ? ` (${probe.displayName})` : "";
  const result = await dialog.showMessageBox(dialogParent(parent), {
    type: "question",
    buttons: ["Autorizar", "Cancelar"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Usar o launcher da Epic",
    message: `Usar a sessão do launcher${name} para puxar a biblioteca?`,
    detail:
      "A senha não passa por aqui. A Epic só mantém um token: se o launcher estiver aberto, feche e abra de novo depois.",
  });
  return result.response === 0;
}

function captureEpicAuth(parent) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 980,
      height: 720,
      parent: dialogParent(parent),
      modal: Boolean(dialogParent(parent)),
      title: "Entrar na Epic Games",
      backgroundColor: "#12161d",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: "persist:epic-login",
      },
    });
    let done = false;
    let kickedRedirect = false;
    let poll = null;
    const finish = (err, payload) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // janela já fechou
      }
      if (err) reject(err);
      else resolve(payload);
    };

    const sniff = async () => {
      if (done || win.isDestroyed()) return;
      const current = win.webContents.getURL();
      try {
        const text = await win.webContents.executeJavaScript(
          "(function(){ try { return (document.body && document.body.innerText) || ''; } catch (e) { return ''; } })()",
          true
        );
        const parsed = parseEpicRedirectPayload(text);
        if (parsed.authorizationCode) {
          finish(null, parsed);
          return;
        }
        if (/\/id\/api\/redirect/i.test(current) && parsed.sid) {
          if (!kickedRedirect) {
            kickedRedirect = true;
            win.loadURL(REDIRECT_URL);
            return;
          }
          finish(null, parsed);
        }
      } catch {
        // ainda carregando o JSON
      }
    };

    const maybeKickRedirect = () => {
      if (done || kickedRedirect || win.isDestroyed()) return;
      const current = win.webContents.getURL();
      if (!/epicgames\.com/i.test(current)) return;
      if (/\/id\/api\/redirect/i.test(current)) return;
      if (/\/id\/(login|register|logout|password)/i.test(current)) return;
      kickedRedirect = true;
      win.loadURL(REDIRECT_URL);
    };

    win.webContents.on("did-finish-load", () => {
      sniff();
      maybeKickRedirect();
    });
    win.webContents.on("did-navigate", sniff);
    win.webContents.on("did-navigate-in-page", sniff);
    win.webContents.on("did-stop-loading", sniff);
    win.webContents.on("will-redirect", (_event, url) => {
      if (/\/id\/api\/redirect/i.test(String(url || ""))) setTimeout(sniff, 80);
    });
    poll = setInterval(() => {
      sniff();
      maybeKickRedirect();
    }, 400);
    win.on("closed", () => {
      if (!done) reject(new Error("Login da Epic cancelado."));
    });
    win.loadURL(epicAuthUrl());
  });
}

async function loginOnEpicSite(parent) {
  const captured = await captureEpicAuth(parent);
  let authorizationCode = captured?.authorizationCode || "";
  if (!authorizationCode && captured?.sid) {
    authorizationCode = await exchangeSidForCode(captured.sid);
  }
  if (!authorizationCode) {
    throw new Error("A Epic não devolveu o código de autorização.");
  }
  return startEpicSession({ authorizationCode });
}

async function loginWithEpic(parent, opts = {}) {
  let mode = opts.mode || "auto";
  const probe = probeEglSession();
  if (mode === "auto") {
    mode = probe.available ? await chooseEpicLogin(parent, probe) : "web";
  }
  if (mode === "egl") {
    if (!probe.available) {
      throw new Error("O launcher da Epic neste PC não tem uma sessão salva. Entre no site da Epic.");
    }
    if (opts.mode === "egl") {
      const ok = await confirmEglImport(parent, probe);
      if (!ok) throw new Error("Login da Epic cancelado.");
    }
    try {
      return await importEglSession();
    } catch (error) {
      const result = await dialog.showMessageBox(dialogParent(parent), {
        type: "warning",
        buttons: ["Entrar no site da Epic", "Cancelar"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Launcher da Epic",
        message: "Não deu para reutilizar a sessão do launcher.",
        detail: `${error.message || error}\n\nO launcher aberto às vezes já girou o token. Pode entrar no site da Epic (a senha fica lá).`,
      });
      if (result.response !== 0) throw error;
      return loginOnEpicSite(parent);
    }
  }
  return loginOnEpicSite(parent);
}

module.exports = { loginWithEpic };
