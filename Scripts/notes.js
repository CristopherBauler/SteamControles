/**
 * Gera e atualiza as notas Markdown de cada jogo.
 * O bloco "## Notas" escrito por você é preservado.
 */

const fs = require("fs/promises");
const path = require("path");
const { formatBRL, roundMoney } = require("./config");

function yamlScalar(value) {
  if (value == null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  const text = String(value);
  if (text === "") return '""';
  if (/[:#\[\]{}&*!|>'"%@`\n]/.test(text) || /^(true|false|null|yes|no)$/i.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function yamlMoney(value) {
  if (value == null) return "null";
  return roundMoney(value).toFixed(2);
}

function parseYamlValue(raw) {
  const value = raw.trim();
  if (value === "null" || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value.replace(/^'/, '"').replace(/'$/, '"'));
    } catch {
      return value.slice(1, -1);
    }
  }
  const num = Number(value);
  if (value !== "" && !Number.isNaN(num)) return num;
  return value;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = parseYamlValue(kv[2]);
  }
  return { fm, body: match[2] };
}

function extractUserNotes(body) {
  const marker = "## Notas";
  const index = body.indexOf(marker);
  if (index === -1) return "";
  return body.slice(index + marker.length).replace(/^\r?\n/, "");
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[™®©]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "jogo";
}

async function listGameNotes(gamesDir) {
  try {
    const files = await fs.readdir(gamesDir);
    return files.filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
}

async function loadExistingNotes(gamesDir) {
  const byAppId = new Map();
  for (const file of await listGameNotes(gamesDir)) {
    const content = await fs.readFile(path.join(gamesDir, file), "utf8");
    const parsed = parseFrontmatter(content);
    const appId = Number(parsed.fm.steam_appid);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    byAppId.set(appId, {
      fileName: file,
      userNotes: extractUserNotes(parsed.body),
      fm: parsed.fm,
    });
  }
  return byAppId;
}

function historyTable(entries) {
  const rows = (entries || []).slice(-14).reverse();
  if (!rows.length) return "_Sem histórico ainda._";
  const lines = [
    "| Data | Preço | Desconto |",
    "| --- | --- | --- |",
    ...rows.map(
      (entry) =>
        `| ${entry.date} | ${formatBRL(entry.price)} | ${Number(entry.discount || 0)}% |`
    ),
  ];
  return lines.join("\n");
}

function historyChart(entries) {
  const rows = (entries || []).slice(-90);
  if (rows.length < 2) return "";
  const labels = rows.map((entry) => entry.date);
  const data = rows.map((entry) => (entry.price == null ? "null" : entry.price));
  return [
    "```charts",
    "type: line",
    `labels: [${labels.join(", ")}]`,
    "series:",
    "  - title: Preço BRL",
    `    data: [${data.join(", ")}]`,
    "tension: 0.25",
    "fill: false",
    "beginAtZero: false",
    "```",
  ].join("\n");
}

function daysLabel(days, onSale) {
  if (onSale) return "Em promoção agora";
  if (days == null) return "Sem promoção registrada";
  if (days === 0) return "Entrou em promoção hoje";
  if (days === 1) return "Faz 1 dia que não entra em promoção";
  return `Faz ${days} dias que não entra em promoção`;
}

function buildNote(game, { previousFileName, userNotes }) {
  const frontmatter = [
    "---",
    "tags:",
    "  - game",
    "  - steam",
    `steam_appid: ${game.appId}`,
    `name: ${yamlScalar(game.name)}`,
    `header_image: ${yamlScalar(game.headerImage)}`,
    `current_price: ${yamlMoney(game.currentPrice)}`,
    `previous_price: ${yamlMoney(game.previousPrice)}`,
    `price_diff: ${yamlMoney(game.priceDiff)}`,
    `discount: ${yamlScalar(game.discount)}`,
    `sale_amount: ${yamlMoney(game.saleAmount)}`,
    `lowest_price: ${yamlMoney(game.lowestPrice)}`,
    `base_price: ${yamlMoney(game.basePrice)}`,
    `status: ${yamlScalar(game.status)}`,
    `on_wishlist: ${yamlScalar(game.onWishlist)}`,
    `owned: ${yamlScalar(Boolean(game.owned))}`,
    `on_sale: ${yamlScalar(game.onSale)}`,
    `review_desc: ${yamlScalar(game.reviewDesc)}`,
    `review_percent: ${yamlScalar(game.reviewPercent)}`,
    `steam_tags: ${yamlScalar((game.steamTags || []).join(", "))}`,
    `days_since_sale: ${yamlScalar(game.daysSinceSale)}`,
    `last_sale_date: ${yamlScalar(game.lastSaleDate)}`,
    `best_store: ${yamlScalar(game.bestStore)}`,
    `best_store_price: ${yamlMoney(game.bestStorePrice)}`,
    `store_url: ${yamlScalar(game.storeUrl)}`,
    `nuuvem_url: ${yamlScalar(game.nuuvemUrl)}`,
    `gmg_url: ${yamlScalar(game.gmgUrl)}`,
    `fanatical_url: ${yamlScalar(game.fanaticalUrl)}`,
    `updated: ${yamlScalar(game.updatedAt)}`,
    "---",
    "",
  ].join("\n");

  const reviewLine = game.reviewDesc
    ? `${game.reviewDesc}${game.reviewPercent != null ? ` (${game.reviewPercent}%)` : ""}`
    : "—";

  const body = [
    game.headerImage ? `![capa|banner](${game.headerImage})` : "",
    "",
    `# ${game.name}`,
    "",
    `| Campo | Valor |`,
    `|---|---|`,
    `| AppID | \`${game.appId}\` |`,
    `| Preço atual | ${formatBRL(game.currentPrice)} |`,
    `| Diferença | ${formatBRL(game.priceDiff)} |`,
    `| Desconto | ${game.discount ?? 0}% |`,
    `| Menor preço local | ${formatBRL(game.lowestPrice)} |`,
    `| Preço normal gravado | ${formatBRL(game.basePrice)} |`,
    `| Avaliação | ${reviewLine} |`,
    `| Tags | ${game.steamTags?.length ? game.steamTags.join(", ") : "—"} |`,
    `| Promoção | ${daysLabel(game.daysSinceSale, game.onSale)} |`,
    `| Na wishlist | ${game.onWishlist ? "sim" : "não"} |`,
    `| Na biblioteca | ${game.owned ? "Comprado" : "não"} |`,
    "",
    `- [Steam](${game.storeUrl})`,
    `- [Nuuvem](${game.nuuvemUrl})`,
    `- [Green Man Gaming](${game.gmgUrl})`,
    `- [Fanatical](${game.fanaticalUrl})`,
    "",
    "## Histórico",
    "",
    historyTable(game.history),
    "",
    historyChart(game.history),
    "",
    "## Notas",
    "",
    (userNotes || "").trimEnd(),
  ]
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""))
    .join("\n")
    .trimEnd();

  return {
    fileName: `${sanitizeFileName(game.name)}.md`,
    previousFileName,
    content: `${frontmatter}${body}\n`,
  };
}

async function writeGameNote(gamesDir, note) {
  await fs.mkdir(gamesDir, { recursive: true });
  const nextPath = path.join(gamesDir, note.fileName);
  if (note.previousFileName && note.previousFileName !== note.fileName) {
    try {
      await fs.unlink(path.join(gamesDir, note.previousFileName));
    } catch {
      // arquivo antigo pode já ter sido removido
    }
  }
  await fs.writeFile(nextPath, note.content, "utf8");
}

module.exports = {
  parseFrontmatter,
  loadExistingNotes,
  buildNote,
  writeGameNote,
  daysLabel,
};
