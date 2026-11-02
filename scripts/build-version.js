// version.json を生成する。
//
// data/ は GitHub Actions が毎週自動でコミットするため、git log は
// 「data: 信用残データを更新」で埋まってしまい、コードがいつ変わったのかが
// 追いにくい。そこで「コードの更新」と「データの更新」を分けて記録する。
//
//   node scripts/build-version.js

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "version.json");

// データ更新の自動コミットで変わるパス。ここ以外の変更を「コードの更新」とみなす。
const DATA_PATHS = ["data", "sitemap.xml", "version.json"];

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    return "";
  }
}

// 指定パスを除外した最新コミットを取得する
function lastCodeCommit() {
  const excludes = DATA_PATHS.map((p) => `":(exclude)${p}"`).join(" ");
  const out = git(`log -1 --date=iso-strict --pretty=format:%H%n%ad%n%s -- . ${excludes}`);
  const [hash, date, subject] = out.split("\n");
  return hash ? { hash, date, subject } : null;
}

// データの更新日時は git ではなく保存ファイルの savedAt から取る。
// 同じコミットで version.json も更新するため、git から引くと1コミットぶんずれる。
function lastDataFetch() {
  try {
    const dir = path.join(ROOT, "data");
    let latest = null;
    for (const f of fs.readdirSync(dir).filter((n) => /^[0-9A-Z]{4,5}\.json$/.test(n))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.savedAt && (!latest || j.savedAt > latest)) latest = j.savedAt;
    }
    return latest;
  } catch (e) {
    return null;
  }
}

function savedStockCount() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json"), "utf8"));
    return Array.isArray(j) ? j.length : 0;
  } catch (e) {
    return 0;
  }
}

// 信用残データそのものの最新週 (申込日)
function latestMarginDate() {
  try {
    const dir = path.join(ROOT, "data");
    let latest = null;
    for (const f of fs.readdirSync(dir).filter((f) => /^[0-9A-Z]{4,5}\.json$/.test(f))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const d = j.rows && j.rows[0] && j.rows[0].date;
      if (d && (!latest || d > latest)) latest = d;
    }
    return latest;
  } catch (e) {
    return null;
  }
}

function main() {
  const code = lastCodeCommit();

  // 中身が変わったときだけ差分が出るよう、生成時刻のような揮発値は入れない
  const info = {
    // コードを最後に更新した日時 (data の自動コミットは除外して判定)
    code: code
      ? { updatedAt: code.date, commit: code.hash.slice(0, 7), subject: code.subject }
      : null,
    // 信用残データを最後に取得した日時 (毎週の自動更新)
    data: {
      fetchedAt: lastDataFetch(),
      latestMarginWeek: latestMarginDate(),
      stockCount: savedStockCount(),
    },
  };

  const next = JSON.stringify(info, null, 2) + "\n";
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (prev === next) {
    console.log("version.json に変更はありません");
  } else {
    fs.writeFileSync(OUT, next);
    console.log("version.json を更新しました");
  }
  console.log(`  コード更新: ${info.code ? info.code.updatedAt + " (" + info.code.commit + ")" : "不明"}`);
  console.log(`  データ取得: ${info.data.fetchedAt || "不明"}`);
  console.log(`  最新週    : ${info.data.latestMarginWeek || "不明"} / ${info.data.stockCount} 銘柄`);
}

main();
