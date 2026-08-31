/**
 * Servidor local para o botão Atualizar do painel.
 * Obsidian não consegue rodar .bat sozinho; este HTTP sim.
 *
 *   iniciar-painel.bat
 *   http://127.0.0.1:47822/update
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { paint } = require("./config");

const PORT = 47822;
const ROOT = path.resolve(__dirname, "..");
let running = false;

function html(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:Segoe UI,sans-serif;background:#12161d;color:#e8edf4;margin:0}main{max-width:640px;margin:10vh auto;background:#1a1f27;border:1px solid #2b3240;border-radius:16px;padding:24px}a{color:#58a6ff}pre{white-space:pre-wrap;font-size:12px;color:#9aa4b2}</style>
  </head><body><main>${body}</main></body></html>`;
}

function runUpdate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["Scripts/updateWishlist.js"], {
      cwd: ROOT,
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString();
      process.stdout.write(buf);
    });
    child.stderr.on("data", (buf) => {
      out += buf.toString();
      process.stderr.write(buf);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(out || `exit ${code}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      html(
        "Painel Steam",
        `<h1>Painel no ar</h1><p>No Obsidian, abra <b>Minha Wishlist Steam</b> e clique em <b>Atualizar</b>.</p><p><a href="/update">Atualizar agora</a></p>`
      )
    );
    return;
  }

  if (url.pathname !== "/update") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (running) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html("Aguarde", "<h1>Já está atualizando</h1><p>Espere terminar e volte ao Obsidian.</p>"));
    return;
  }

  running = true;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  try {
    console.log(paint("cyan", "\nAtualização pedida pelo painel...\n"));
    await runUpdate();
    res.end(
      html(
        "Atualizado",
        `<h1>Atualizado</h1><p>Volte ao Obsidian e recarregue a nota <b>Minha Wishlist Steam</b> (Ctrl+R).</p>`
      )
    );
  } catch (error) {
    res.end(html("Erro", `<h1>Falhou</h1><pre>${String(error.message || error)}</pre>`));
  } finally {
    running = false;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(paint("bold", `Painel local em http://127.0.0.1:${PORT}`));
  console.log(paint("dim", "Deixe esta janela aberta. No Obsidian, o botão Atualizar chama esta URL."));
});
