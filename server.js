// 信用残ウォッチ ローカルサーバー
// api/ 以下のサーバーレス関数をそのまま呼び出すので、ローカルと本番で挙動が揃う。
// 依存パッケージなし (Node.js 18+ の標準機能のみ)。
//
// 起動:  node server.js
// URL :  http://localhost:3690/

const http = require("http");
const fs = require("fs");
const path = require("path");

// .env があれば読む (SMTP の設定など)。api/ を読み込む前に済ませる必要がある。
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) {
  // ファイルが無いのは普通のこと。Node 20.6 未満では loadEnvFile 自体が無い
}

const PORT = Number(process.env.PORT) || 3690;
const ROOT = __dirname;

const routes = {
  "/api/margin": require("./api/margin"),
  "/api/quote": require("./api/quote"),
  "/api/search": require("./api/search"),
  "/api/auth": require("./api/auth"),
};

// .data/ と .env は配信しない (利用者のパスワードハッシュや SMTP のパスワードが入る)
const HIDDEN = [".data", ".env", ".git"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  try {
    const handler = routes[u.pathname];
    if (handler) return await handler(req, res);

    // 静的ファイル配信
    let filePath = u.pathname === "/" ? "/index.html" : decodeURIComponent(u.pathname);
    const segments = filePath.split(/[\\/]+/).filter(Boolean);
    filePath = path.normalize(path.join(ROOT, filePath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (segments.some((s) => HIDDEN.includes(s.toLowerCase()))) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "サーバー内部エラーが発生しました" }));
  }
});

// 開発用の機能があるので、同じネットワークの他の機器からは接続させない
server.listen(PORT, "127.0.0.1", () => {
  const st = routes["/api/auth"].status();
  console.log("");
  console.log("  信用残ウォッチ を起動しました");
  console.log(`  ブラウザで http://localhost:${PORT}/ を開いてください`);
  console.log(
    "  アカウント: 保存先 = " +
      (st.storage === "kv" ? "KV (本番と同じ)" : ".data/auth.json") +
      " / メール = " +
      (st.mail === "smtp" ? "SMTP 設定済み" : "未設定 (再設定リンクはここに表示)")
  );
  console.log("  終了するにはこのウィンドウを閉じるか Ctrl+C を押してください");
  console.log("");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`ポート ${PORT} は使用中です。既に起動していないか確認してください。`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
