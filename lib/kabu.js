// 信用残ウォッチ: データ取得ロジック (ローカルサーバー / サーバーレス API 共通)
//
// Yahoo!ファイナンスの信用残時系列ページと SBI証券の個別銘柄ページから
// スクレイピングする。依存パッケージなし (Node.js 18+ の標準機能のみ)。

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 取得結果のキャッシュ。信用残は週1回しか変わらないので、取得元への
// アクセスを減らすため長めに持つ (現在値がその分古くなるのは許容)。
const cache = new Map();
const CACHE_MS = 60 * 60 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { time: Date.now(), data });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Yahoo は IP 単位でレート制限をかけており、混雑時は 429 や 5xx を返す。
// クラウド上の共有IPだと踏みやすいので、待ち時間を空けて数回やり直す。
function isRetryableStatus(status) {
  return status === 429 || status === 408 || status >= 500;
}

async function fetchWithRetry(url, init = {}, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(600 * 2 ** (i - 1) + Math.random() * 400); // 0.6s, 1.2s (+ゆらぎ)
    try {
      const res = await fetch(url, init);
      if (!isRetryableStatus(res.status)) return res;
      last = { status: res.status };
    } catch (e) {
      last = { error: e };
    }
  }
  if (last && last.error) throw last.error;
  // 最後まで再試行対象のステータスだった場合は、そのステータスのまま返す
  return new Response(null, { status: last ? last.status : 500 });
}

async function fetchText(url) {
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" },
  });
  return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "" };
}

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .trim();
}

function toNum(s) {
  const t = String(s).replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

// ---- 履歴の保存先 (data/<code>.json に週次データを蓄積) --------------------
// ローカル実行では書き込み、サーバーレス環境 (読み取り専用FS) では読み込みのみ。

const DATA_DIR = path.join(__dirname, "..", "data");
const READ_ONLY = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function dateKey(d) {
  // "2026/7/3" -> 20260703 (並べ替え用)
  const m = String(d).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

function loadHistory(code) {
  try {
    const p = path.join(DATA_DIR, code + ".json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`履歴読み込みに失敗 (${code}):`, e.message);
  }
  return null;
}

// 保存する JSON は API のレスポンスと同じ形。GitHub Pages などの静的配信では
// この JSON をそのまま読んで表示する (API が無くても画面が成立する)。
function saveHistory(data) {
  if (READ_ONLY) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, data.code + ".json"),
      JSON.stringify({ ...data, savedAt: new Date().toISOString() })
    );
  } catch (e) {
    console.error(`履歴保存に失敗 (${data.code}):`, e.message);
  }
}

// ---- 株価の高値・安値 (上場来・年初来) 取得 ------------------------------
// SBI証券の個別銘柄ページ(ログイン不要・Shift_JIS)から
// 上場来高値/安値・年初来高値/安値・現在値を取得する。SBIは分割前の額面ベースの
// 「本当の上場来」値を上場時まで遡って掲載している。
function sbiExpandYear(yy) {
  const n = Number(yy);
  return n < 50 ? 2000 + n : 1900 + n; // 26->2026, 50->1950
}

function sbiFmtDate(ymd) {
  const m = ymd.match(/(\d{2})\/(\d{2})\/(\d{2})/);
  return m ? `${sbiExpandYear(m[1])}/${Number(m[2])}/${Number(m[3])}` : ymd;
}

async function getSbiHighLow(code) {
  const url =
    "https://site4.sbisec.co.jp/ETGate/?_ControlID=WPLETsiR001Control" +
    "&_DataStoreID=DSWPLETsiR001Control&_PageID=WPLETsiR001Ilst10" +
    "&_ActionID=getDetailOfStockPriceJP&s_rkbn=1&i_dom_flg=1&i_exchange_code=JPN" +
    `&i_output_type=0&stock_sec_code_mul=${encodeURIComponent(code)}` +
    "&exchange_code=TKY&ref_from=1&ref_to=20&getFlg=on";
  const result = {
    allTimeHigh: null, allTimeLow: null, yearHigh: null, yearLow: null,
    price: null, earnings: null,
  };
  try {
    const res = await fetchWithRetry(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" },
    });
    if (!res.ok) return result;
    const buf = Buffer.from(await res.arrayBuffer());
    const html = new TextDecoder("shift_jis").decode(buf);
    // タグとカンマを除去して「ラベル 数値 (YY/MM/DD)」を拾う
    const text = html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/,/g, "")
      .replace(/\s+/g, " ");
    const pick = (label) => {
      const m = text.match(
        new RegExp(label + "\\s*(\\d+(?:\\.\\d+)?)\\s*\\((\\d{2}/\\d{2}/\\d{2})\\)")
      );
      return m ? { value: Number(m[1]), date: sbiFmtDate(m[2]) } : null;
    };
    result.allTimeHigh = pick("上場来高値");
    result.allTimeLow = pick("上場来安値");
    result.yearHigh = pick("年初来高値");
    result.yearLow = pick("年初来安値");
    // 現在値 (年初来レンジ内の位置表示用)
    const pm = text.match(/現在値\s*(\d+(?:\.\d+)?)/);
    if (pm) result.price = Number(pm[1]);
    // 決算発表(予定)日: title="決算発表日：2026/08/04（予定）" の形で埋め込まれている
    const em = html.match(/決算発表日[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(（予定）|\(予定\))?/);
    if (em) {
      result.earnings = {
        date: `${em[1]}/${Number(em[2])}/${Number(em[3])}`,
        iso: `${em[1]}-${String(em[2]).padStart(2, "0")}-${String(em[3]).padStart(2, "0")}`,
        planned: !!em[4],
      };
    }
  } catch (e) {
    console.error(`SBIデータ取得に失敗 (${code}):`, e.message);
  }
  return result;
}

async function getReference(code) {
  const key = "ref:" + code;
  const cached = cacheGet(key);
  if (cached) return cached;

  // 上場来・年初来の高値安値はいずれも SBI証券から取得
  const sbi = await getSbiHighLow(code);
  const ref = {
    allTimeHigh: sbi.allTimeHigh,
    allTimeLow: sbi.allTimeLow,
    yearHigh: sbi.yearHigh,
    yearLow: sbi.yearLow,
    price: sbi.price,
    earnings: sbi.earnings,
  };

  cacheSet(key, ref);
  return ref;
}

// ---- 株価の週次終値 (信用残の各週に対応づける用) ------------------------
// Yahoo(米国)chart API の日足から日付→終値のマップを作る。信用残の申込日
// (通常は金曜)にちょうど一致する終値を引く。直近2年ぶんで表・グラフに十分。
async function getCloseMap(code) {
  const map = new Map();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=2y&interval=1d`;
    const res = await fetchWithRetry(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return map;
    const j = await res.json();
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) return map;
    const ts = r.timestamp;
    const close = r.indicators.quote[0].close;
    for (let i = 0; i < ts.length; i++) {
      if (close[i] == null) continue;
      const d = new Date((ts[i] + 9 * 3600) * 1000); // JST
      map.set(`${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`, close[i]);
    }
  } catch (e) {
    console.error(`株価履歴取得に失敗 (${code}):`, e.message);
  }
  return map;
}

// "2026/7/17" の終値を取得。休場日ならその直前の営業日まで最大5日遡る。
function closeForDate(map, ymd) {
  if (map.has(ymd)) return map.get(ymd);
  const m = ymd.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  for (let k = 0; k < 5; k++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const key = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    if (map.has(key)) return map.get(key);
  }
  return null;
}

// ---- 信用残データ取得 ----------------------------------------------------

async function getMargin(code) {
  const key = "margin:" + code;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://finance.yahoo.co.jp/quote/${code}.T/margin`;
  // 信用残・高値安値/決算・株価履歴を並行取得
  const [{ ok, status, text: html }, ref, closeMap] = await Promise.all([
    fetchText(url),
    getReference(code),
    getCloseMap(code),
  ]);
  if (!ok) {
    // 429/5xx は取得元のレート制限。銘柄が存在しないわけではないので区別して伝える。
    if (isRetryableStatus(status)) {
      // 保存済みのデータがあれば、エラーにせずそれを返す (画面が出るほうが有用)
      const stored = loadHistory(code);
      if (stored && Array.isArray(stored.rows) && stored.rows.length) {
        return { ...stored, stale: true };
      }
      return {
        error:
          "取得元(Yahoo!ファイナンス)が混み合っていて取得できませんでした。" +
          `少し時間をおいて再度お試しください (HTTP ${status})`,
        retryable: true,
      };
    }
    return { error: `銘柄コード「${code}」のページが見つかりませんでした (HTTP ${status})` };
  }

  // 銘柄名は <title>トヨタ自動車(株)【7203】：…</title> から取る
  let name = code;
  const titleM = html.match(/<title>([^<]*)<\/title>/);
  if (titleM) {
    const m = titleM[1].match(/^(.*?)【/);
    if (m) name = m[1].trim();
  }

  const tableM = html.match(
    /<table[^>]*aria-label="信用残時系列のテーブル"[\s\S]*?<\/table>/
  );
  if (!tableM) {
    return {
      error: `「${code}」の信用残データが見つかりませんでした (信用取引の対象外か、コードが正しくない可能性があります)`,
    };
  }

  // 各行: 日付 / 売残 / 買残 / 売残増減 / 買残増減 / 信用倍率
  const rows = [];
  for (const trM of tableM[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...trM[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(
      (m) => stripTags(m[1])
    );
    if (cells.length !== 6 || !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(cells[0])) continue;
    const row = {
      date: cells[0],
      sell: toNum(cells[1]),        // 売り残 (株)
      buy: toNum(cells[2]),         // 買い残 (株)
      sellChange: toNum(cells[3]),  // 売残の前週比 (株)
      buyChange: toNum(cells[4]),   // 買残の前週比 (株)
      ratio: toNum(cells[5]),       // 信用倍率 (倍)
    };
    // 前週比率 (%) = 増減 ÷ 前週残高 × 100
    const prevBuy = row.buy != null && row.buyChange != null ? row.buy - row.buyChange : null;
    const prevSell = row.sell != null && row.sellChange != null ? row.sell - row.sellChange : null;
    row.buyPct = prevBuy ? (row.buyChange / prevBuy) * 100 : null;
    row.sellPct = prevSell ? (row.sellChange / prevSell) * 100 : null;
    rows.push(row);
  }

  if (rows.length === 0) {
    return { error: `「${code}」の信用残データを解析できませんでした` };
  }

  // 過去に保存した分とマージして蓄積 (Yahoo の掲載期間より古いデータも残る)
  const stored = loadHistory(code);
  const byDate = new Map();
  if (stored && Array.isArray(stored.rows)) {
    for (const r of stored.rows) byDate.set(r.date, r);
  }
  for (const r of rows) byDate.set(r.date, r); // 新しい取得分を優先
  const merged = [...byDate.values()].sort((a, b) => dateKey(b.date) - dateKey(a.date));

  // 各週の申込日に対応する株価(終値)を付与。取得できた場合のみ上書きし、
  // 履歴取得に失敗しても過去に保存済みの終値は保持する。
  if (closeMap.size > 0) {
    for (const r of merged) {
      const c = closeForDate(closeMap, r.date);
      if (c != null) r.close = Math.round(c * 10) / 10;
    }
  }

  const data = {
    code,
    name,
    source: url,
    rows: merged,
    yearHigh: ref.yearHigh,
    yearLow: ref.yearLow,
    allTimeHigh: ref.allTimeHigh,
    allTimeLow: ref.allTimeLow,
    price: ref.price,
    earnings: ref.earnings,
  };
  saveHistory(data);
  cacheSet(key, data);
  return data;
}

// ---- 銘柄名検索 -----------------------------------------------------------

async function searchStocks(q) {
  const key = "search:" + q;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://finance.yahoo.co.jp/search/?query=${encodeURIComponent(q)}`;
  const { ok, status, text: html } = await fetchText(url);
  if (!ok) {
    if (isRetryableStatus(status)) {
      return {
        error:
          "取得元(Yahoo!ファイナンス)が混み合っていて検索できませんでした。" +
          `少し時間をおいて再度お試しください (HTTP ${status})`,
        retryable: true,
      };
    }
    return { error: `検索に失敗しました (HTTP ${status})` };
  }

  const results = [];
  const seen = new Set();
  for (const artM of html.matchAll(/<article class="SearchItem[\s\S]*?<\/article>/g)) {
    const block = artM[0];
    const codeM = block.match(/\/quote\/([0-9A-Z]{4,5})\.T["/]/);
    if (!codeM || seen.has(codeM[1])) continue;
    const nameM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const sups = [...block.matchAll(/SearchItem__supplement[^"]*"[^>]*>([\s\S]*?)<\/li>/g)].map(
      (m) => stripTags(m[1])
    );
    seen.add(codeM[1]);
    results.push({
      code: codeM[1],
      name: nameM ? stripTags(nameM[1]) : codeM[1],
      market: sups[1] || "",
    });
    if (results.length >= 10) break;
  }

  const data = { query: q, results };
  cacheSet(key, data);
  return data;
}

module.exports = { getMargin, searchStocks, loadHistory, DATA_DIR, dateKey };
