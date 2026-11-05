// GitHub Pages など静的ホスティングから API を呼ぶ先の URL。
//
// ローカル (localhost) で `node server.js` を動かしている場合はこの設定は無視され、
// 同じサーバーの /api/... が使われます。
//
// Vercel などに API をデプロイしたら、そのURL(末尾スラッシュなし)をここに入れてください。
//   例) window.KABU_API_BASE = "https://kabu-shinyo-checker.vercel.app";
//
// 空のままだと、GitHub Actions が定期取得して data/ に保存したJSONを読む
// 「保存済みデータ表示モード」で動作します。
window.KABU_API_BASE = "https://kabu-shinyo-checker.vercel.app";
