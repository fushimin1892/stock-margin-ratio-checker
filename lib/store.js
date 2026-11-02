// アカウント情報の保存層 (キーバリュー + 有効期限)。
//
// 置き場所は2つあり、環境変数の有無で自動的に切り替わる。
//   1. Redis REST (Vercel KV / Upstash)  … 本番。サーバーレスはファイルに書けないので必須
//   2. ローカルの JSON ファイル (.data/)  … 開発。追加サービスなしで動かすため
//
// 追加パッケージは使わない (Redis は REST API を fetch で叩くだけ)。

const fs = require("fs");
const path = require("path");

const REQUEST_TIMEOUT_MS = 8000;
const FILE_PATH = path.join(__dirname, "..", ".data", "auth.json");

// Vercel KV と Upstash で環境変数名が違うだけで中身は同じ REST API。
const REST_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "")
  .replace(/\/+$/, "");
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const useRest = Boolean(REST_URL && REST_TOKEN);
// サーバーレスのファイルシステムは読み取り専用 + 実行のたびに消えるため、
// Redis が未設定の本番では「保存できない」ことを呼び出し側に伝える。
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/* ---------------- Redis REST ---------------- */

async function redis(command) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command.map(String)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`保存先(KV)でエラーが発生しました: ${body.error || res.status}`);
  }
  return body.result;
}

/* ---------------- ローカルの JSON ファイル ----------------
   1ファイルを丸ごと読み書きする。扱う件数が個人利用の規模なので十分。
   書き込みは「一時ファイル → rename」にして、途中で落ちても壊れないようにする。 */

// 同時に書いて上書きし合わないよう、ファイル操作は1本の Promise 鎖に並べる
let fileQueue = Promise.resolve();
function inFileQueue(fn) {
  const next = fileQueue.then(fn, fn);
  // 失敗しても後続を止めない (rejection はここでは握りつぶさず呼び出し側へ返す)
  fileQueue = next.then(() => {}, () => {});
  return next;
}

function readFileSync_() {
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function writeFileSync_(obj) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  const tmp = FILE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, FILE_PATH);
}

// 期限切れを取り除きながら読む
function loadLive() {
  const all = readFileSync_();
  const now = Date.now();
  let changed = false;
  for (const [k, rec] of Object.entries(all)) {
    if (rec && rec.e && rec.e <= now) {
      delete all[k];
      changed = true;
    }
  }
  return { all, changed };
}

/* ---------------- 共通 API ----------------
   値は JSON にして保存する。TTL の単位は秒。 */

async function get(key) {
  if (useRest) {
    const raw = await redis(["GET", key]);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return inFileQueue(() => {
    const { all, changed } = loadLive();
    if (changed) writeFileSync_(all);
    return all[key] ? all[key].v : null;
  });
}

async function set(key, value, ttlSec = null) {
  if (useRest) {
    const cmd = ["SET", key, JSON.stringify(value)];
    if (ttlSec) cmd.push("EX", Math.ceil(ttlSec));
    await redis(cmd);
    return true;
  }
  return inFileQueue(() => {
    const { all } = loadLive();
    all[key] = { v: value, e: ttlSec ? Date.now() + ttlSec * 1000 : null };
    writeFileSync_(all);
    return true;
  });
}

// 既にキーがあれば書かずに false を返す (メールアドレスの重複登録を防ぐのに使う)
async function setIfAbsent(key, value, ttlSec = null) {
  if (useRest) {
    const cmd = ["SET", key, JSON.stringify(value), "NX"];
    if (ttlSec) cmd.push("EX", Math.ceil(ttlSec));
    return (await redis(cmd)) === "OK";
  }
  return inFileQueue(() => {
    const { all } = loadLive();
    if (all[key]) return false;
    all[key] = { v: value, e: ttlSec ? Date.now() + ttlSec * 1000 : null };
    writeFileSync_(all);
    return true;
  });
}

async function del(key) {
  if (useRest) {
    await redis(["DEL", key]);
    return true;
  }
  return inFileQueue(() => {
    const { all } = loadLive();
    delete all[key];
    writeFileSync_(all);
    return true;
  });
}

// 1増やして増やしたあとの値を返す。初回だけ有効期限を付ける (回数制限用)。
async function incr(key, ttlSec) {
  if (useRest) {
    const n = await redis(["INCR", key]);
    if (n === 1 && ttlSec) await redis(["EXPIRE", key, Math.ceil(ttlSec)]);
    return n;
  }
  return inFileQueue(() => {
    const { all } = loadLive();
    const cur = all[key] ? Number(all[key].v) || 0 : 0;
    const n = cur + 1;
    all[key] = {
      v: n,
      e: all[key] && all[key].e ? all[key].e : ttlSec ? Date.now() + ttlSec * 1000 : null,
    };
    writeFileSync_(all);
    return n;
  });
}

// 保存先が使える状態か。false のときアカウント機能は無効にする。
function isReady() {
  return useRest || !isServerless;
}

function describe() {
  if (useRest) return "kv";
  return isServerless ? "none" : "file";
}

// 保存先が未設定のときに画面へ出す案内
const NOT_READY_MESSAGE =
  "アカウント機能が有効になっていません (保存先が未設定です)。" +
  "Vercel の Storage で KV を接続し、KV_REST_API_URL / KV_REST_API_TOKEN を設定してください。";

module.exports = { get, set, setIfAbsent, del, incr, isReady, describe, NOT_READY_MESSAGE };
