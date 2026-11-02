// sitemap.xml を生成する。保存済み銘柄 (data/index.json) のページも列挙するので、
// 銘柄が増えるたびに手で書き足す必要がない。
//
//   node scripts/build-seo.js

const fs = require("fs");
const path = require("path");

const SITE = (process.env.SITE_URL || "http://localhost:3690/").replace(/\/*$/, "/");
const ROOT = path.join(__dirname, "..");
const INDEX_FILE = path.join(ROOT, "data", "index.json");

function savedStocks() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return [];
  }
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [{ loc: SITE, priority: "1.0", changefreq: "weekly" }];

  // ?code=7203 で直接開けるので、保存済み銘柄も個別URLとして載せる
  for (const s of savedStocks()) {
    urls.push({
      loc: `${SITE}?code=${encodeURIComponent(s.code)}`,
      priority: "0.6",
      changefreq: "weekly",
    });
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          "  <url>\n" +
          `    <loc>${u.loc}</loc>\n` +
          `    <lastmod>${today}</lastmod>\n` +
          `    <changefreq>${u.changefreq}</changefreq>\n` +
          `    <priority>${u.priority}</priority>\n` +
          "  </url>"
      )
      .join("\n") +
    "\n</urlset>\n";

  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), xml);
  console.log(`sitemap.xml を生成しました (${urls.length} URL)`);
}

main();
