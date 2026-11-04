// 別オリジンの画面から API を呼べるようにする共通処理。
// 参照系 (信用残・銘柄検索) は公開データなので任意オリジンを許可する。
// アカウント系だけは許可リスト方式にしたいので、opts.origins で切り替えられる。

// アカウント系 API を呼んでよいオリジン。
// 追加は環境変数 ALLOWED_ORIGINS (カンマ区切り) で行う。
function allowedOrigins() {
  const list = [
    "https://kabu-shinyo-checker.vercel.app",
    "https://fushimin1892.github.io",
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()),
  ];
  if (process.env.SITE_URL) {
    try {
      list.push(new URL(process.env.SITE_URL).origin);
    } catch (e) { /* 形式が不正なら無視する */ }
  }
  return list.filter(Boolean);
}

// 手元で動かすときはポートを固定していないので、localhost はまとめて許可する
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);

function isAllowedOrigin(origin) {
  return isLocalOrigin(origin) || allowedOrigins().includes(origin);
}

function applyCors(res, opts = {}) {
  res.setHeader("Access-Control-Allow-Origin", opts.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", opts.methods || "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", opts.headers || "Content-Type");
  // 許可オリジンが相手によって変わる場合、CDN に取り違えさせない
  if (opts.origin && opts.origin !== "*") res.setHeader("Vary", "Origin");

  // vercel.json の headers 設定が反映されないため、応答側で直接付ける。
  // JSON しか返さないので MIME スニッフィングと埋め込みは禁止しておく。
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
}

// プリフライト、または許可していないオリジンからの呼び出しなら true を返す
// (呼び出し側はそこで処理を終える)。
//
// opts.restrict を付けるとアカウント系向けの挙動になる:
//   許可リストのオリジンだけを通し、Authorization ヘッダーと POST を許可する。
function handlePreflight(req, res, opts = {}) {
  const origin = req.headers.origin;

  if (opts.restrict) {
    // Origin が無いのは同一オリジンや curl から。ブラウザの別オリジンではないので通す
    if (origin && !isAllowedOrigin(origin)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ error: "このオリジンからは利用できません" }));
      return true;
    }
    applyCors(res, {
      origin: origin || "*",
      methods: "GET, POST, OPTIONS",
      headers: "Content-Type, Authorization",
    });
  } else {
    applyCors(res, opts);
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

// sMaxAge を渡すと CDN の保持時間を上書きできる (保存済みデータを返したときなど、
// 早めに取得し直したいケース用)。swr は期限切れの内容を返してよい秒数。
function sendJson(res, obj, status = 200, sMaxAge = null, swr = 604800) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (status === 200 && sMaxAge != null) {
    res.setHeader(
      "Cache-Control",
      `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`
    );
  } else if (status === 200) {
    // 信用残は週1回しか更新されない。取得元へのアクセスを減らすことが
    // レート制限への一番の対策なので、CDN に長めに持たせる。
    //   s-maxage=3600            … 同じ銘柄への取得は最大でも1時間に1回
    //   stale-while-revalidate=7日 … 取得元が詰まっていても直近の内容を返し続ける
    // 現在の株価はここに含めず、/api/quote で別に短い間隔で取得する。
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=3600, stale-while-revalidate=604800"
    );
  } else {
    // エラーはキャッシュしない (一時的な失敗が固定化されるのを防ぐ)
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(JSON.stringify(obj));
}

module.exports = { applyCors, handlePreflight, sendJson, isAllowedOrigin, isLocalOrigin };
