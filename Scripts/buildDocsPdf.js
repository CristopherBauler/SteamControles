/**
 * Gera Docs/Como o app foi feito.pdf a partir do HTML.
 *   npm run docs:pdf
 */

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const htmlPath = path.join(__dirname, "..", "Docs", "como-o-app-foi-feito.html");
const pdfPath = path.join(__dirname, "..", "Docs", "Como o app foi feito.pdf");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true },
  });
  await win.loadFile(htmlPath);
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: "A4",
    landscape: false,
  });
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, pdf);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
