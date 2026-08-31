/**
 * Login oficial "Sign in through Steam" (OpenID).
 *   npm run login
 *   ou conectar-steam.bat
 */

const http = require("http");
const { exec } = require("child_process");
const { readJson, writeJson, CONFIG_PATH, paint } = require("./config");

const PORT = 47821;
const REALM = `http://127.0.0.1:${PORT}`;
const RETURN_TO = `${REALM}/callback`;
const STEAM_OPENID = "https://steamcommunity.com/openid/login";

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: Segoe UI, sans-serif; background: #12161d; color: #e8edf4; margin: 0; }
    main { max-width: 560px; margin: 12vh auto; background: #1a1f27; border: 1px solid #2b3240; border-radius: 16px; padding: 28px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { line-height: 1.5; color: #c5ccd6; }
    .ok { color: #3dd68c; font-weight: 700; }
    .warn { color: #f0c14b; }
    code { background: #243044; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function steamAuthUrl() {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": RETURN_TO,
    "openid.realm": REALM,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `${STEAM_OPENID}?${params}`;
}

function extractSteamId(claimedId) {
  const match = String(claimedId || "").match(/\/openid\/id\/(\d{17})$/);
  return match ? match[1] : null;
}

async function verifyOpenId(query) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return /is_valid\s*:\s*true/i.test(text);
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command);
}

async function saveSteamId(steamId) {
  const config = await readJson(CONFIG_PATH, {});
  config.steamId = steamId;
  config.profileUrl = `https://steamcommunity.com/profiles/${steamId}`;
  await writeJson(CONFIG_PATH, config);
}

function start() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REALM);

    if (url.pathname === "/") {
      res.writeHead(302, { Location: steamAuthUrl() });
      res.end();
      return;
    }

    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const valid = await verifyOpenId(query);
      const steamId = extractSteamId(query["openid.claimed_id"]);
      if (!valid || !steamId) {
        throw new Error("A Steam não confirmou o login.");
      }

      await saveSteamId(steamId);
      console.log(paint("green", `\nLogin ok. SteamID64 salvo: ${steamId}`));
      console.log(paint("yellow", "Deixe a wishlist PÚBLICA: Perfil Steam → Privacidade → Lista de desejos."));
      console.log(paint("dim", "Pode fechar o navegador e esta janela.\n"));

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Steam conectada",
          `<h1 class="ok">Steam conectada</h1>
           <p>SteamID <code>${steamId}</code> gravado no <code>config.json</code>.</p>
           <p class="warn">A lista de desejos precisa estar <strong>pública</strong> para o dashboard ler os jogos.</p>
           <p>Feche esta aba e volte ao <code>conectar-steam.bat</code>.</p>`
        )
      );
      setTimeout(() => process.exit(0), 400);
    } catch (error) {
      console.error(paint("red", error.message));
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage("Falha no login", `<h1>Não foi possível conectar</h1><p>${String(error.message)}</p>`)
      );
      setTimeout(() => process.exit(1), 800);
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `${REALM}/`;
    console.log(paint("bold", "Conectar Steam — login oficial no navegador\n"));
    console.log(paint("dim", "Este projeto nunca recebe sua senha. A Steam autentica e devolve só o ID."));
    console.log(paint("cyan", `Abrindo ${url}`));
    openBrowser(url);
  });

  setTimeout(() => {
    console.error(paint("red", "Tempo esgotado. Rode de novo: conectar-steam.bat"));
    process.exit(1);
  }, 5 * 60 * 1000);
}

start();
