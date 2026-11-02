// data/ に保存済みの銘柄を再取得して JSON を更新し、一覧 data/index.json を作り直す。
// GitHub Actions から週次で実行する想定。
//
//   node scripts/update-data.js            … 保存済み銘柄をすべて更新
//   node scripts/update-data.js 7203 6758  … 指定銘柄を追加/更新 (保存済み分も更新)
//   node scripts/update-data.js --only 7203  … 指定銘柄だけ更新

const fs = require("fs");
const path = require("path");
const { getMargin, DATA_DIR } = require("../lib/kabu");

const INDEX_FILE = path.join(DATA_DIR, "index.json");
// 取得元は IP 単位でレート制限をかけるため、1銘柄ごとに十分間を空ける
// (1銘柄あたり Yahoo信用残・SBI・株価履歴の3リクエストを投げる)
const SLEEP_MS = Number(process.env.FETCH_INTERVAL_MS) || 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function savedCodes() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^[0-9A-Z]{4,5}\.json$/.test(f))
    .map((f) => path.basename(f, ".json"))
    .sort();
}

function buildIndex() {
  const stocks = [];
  for (const code of savedCodes()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, code + ".json"), "utf8"));
      const latest = Array.isArray(j.rows) && j.rows.length ? j.rows[0] : null;
      stocks.push({
        code,
        name: j.name || code,
        market: latest ? latest.date + " 時点" : "",
        savedAt: j.savedAt || null,
      });
    } catch (e) {
      console.error(`  ! index 作成でスキップ (${code}): ${e.message}`);
    }
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(stocks, null, 2) + "\n");
  console.log(`\ndata/index.json を更新しました (${stocks.length} 銘柄)`);
}

async function main() {
  const args = process.argv.slice(2);
  const onlyMode = args[0] === "--only";
  const given = (onlyMode ? args.slice(1) : args)
    .flatMap((a) => a.split(/[\s,]+/))
    .map((c) => c.toUpperCase().trim())
    .filter((c) => /^[0-9A-Z]{4,5}$/.test(c));

  const codes = onlyMode ? given : [...new Set([...savedCodes(), ...given])].sort();
  if (!codes.length) {
    console.log("更新対象の銘柄がありません (data/ が空です)");
    buildIndex();
    return;
  }

  console.log(`${codes.length} 銘柄を更新します: ${codes.join(", ")}\n`);
  let ok = 0;
  let failed = 0;
  for (const code of codes) {
    process.stdout.write(`  ${code} … `);
    try {
      const data = await getMargin(code); // 成功すると data/<code>.json に保存される
      if (data.error) {
        console.log(`失敗: ${data.error}`);
        failed++;
      } else {
        console.log(`OK (${data.name} / ${data.rows.length} 週分 / 最新 ${data.rows[0].date})`);
        ok++;
      }
    } catch (e) {
      console.log(`失敗: ${e.message}`);
      failed++;
    }
    await sleep(SLEEP_MS);
  }

  console.log(`\n完了: 成功 ${ok} 件 / 失敗 ${failed} 件`);
  buildIndex();

  // 1件も取得できなかった場合はワークフローを失敗させて気付けるようにする
  if (ok === 0 && codes.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
