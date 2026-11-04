// GET /api/quote?code=7203 — 指定銘柄の現在の株価を返す
const { getQuote } = require("../lib/kabu");
const { handlePreflight, sendJson } = require("../lib/cors");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!/^[0-9A-Z]{4,5}$/.test(code)) {
    return sendJson(res, { error: "銘柄コードの形式が正しくありません" }, 400);
  }

  try {
    const data = await getQuote(code);
    const status = !data.error ? 200 : data.retryable ? 503 : 404;
    // 信用残と違って古い値を長く返すと困るので、CDN には1分だけ持たせる
    return sendJson(res, data, status, 60, 30);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: "サーバー内部エラーが発生しました" }, 500);
  }
};
