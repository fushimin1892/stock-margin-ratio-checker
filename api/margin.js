// GET /api/margin?code=7203 — 指定銘柄の信用残・株価レンジ・決算日を返す
const { getMargin } = require("../lib/kabu");
const { handlePreflight, sendJson } = require("../lib/cors");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;

  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("code") || "").toUpperCase().trim();
  if (!/^[0-9A-Z]{4,5}$/.test(code)) {
    return sendJson(res, { error: "銘柄コードの形式が正しくありません" }, 400);
  }

  try {
    const data = await getMargin(code);
    // 取得元の一時的な不調は 503 (銘柄が無いわけではない)
    const status = !data.error ? 200 : data.retryable ? 503 : 404;
    // 取得できず保存済みを返した場合は短めのキャッシュにして、早めに取り直す
    return sendJson(res, data, status, data.stale ? 120 : null);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: "サーバー内部エラー: " + err.message }, 500);
  }
};
