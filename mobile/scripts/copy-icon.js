const fs = require("fs");
const path = require("path");

const iconSrc = path.resolve(__dirname, "..", "..", "desktop", "icon.png");
const androidRes = path.resolve(__dirname, "..", "android", "app", "src", "main", "res");

if (!fs.existsSync(iconSrc)) {
  console.error("Não achei desktop/icon.png");
  process.exit(1);
}
if (!fs.existsSync(androidRes)) {
  console.error("Pasta android/app ainda não existe. Rode npx cap add android.");
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const replaceNames = new Set([
  "ic_launcher.png",
  "ic_launcher_round.png",
  "ic_launcher_foreground.png",
  "splash.png",
]);

for (const file of walk(androidRes)) {
  if (replaceNames.has(path.basename(file).toLowerCase())) {
    fs.copyFileSync(iconSrc, file);
  }
}

const bgPath = path.join(androidRes, "values", "ic_launcher_background.xml");
if (fs.existsSync(bgPath)) {
  fs.writeFileSync(
    bgPath,
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#12161d</color>
</resources>
`
  );
}

console.log("Ícone copiado de desktop/icon.png para os recursos Android.");
