// アカウント API — /api/auth?action=... で操作を切り替える。
//
//   POST  ?action=register        { email, password }        新規登録
//   POST  ?action=login           { email, password }        ログイン
//   POST  ?action=logout                                     ログアウト
//   GET   ?action=me                                         ログイン中のユーザー
//   POST  ?action=forgot          { email }                  再設定メールの送信
//   POST  ?action=reset           { token, password }        パスワードの変更
//   GET   ?action=history                                    検索履歴
//   POST  ?action=history-add     { code, name }             検索履歴に追加
//   POST  ?action=history-remove  { code }                   1件削除
//   POST  ?action=history-clear                              全消去
//
// ログイン状態は Authorization: Bearer <token> で持つ。
// 画面(GitHub Pages)と API(Vercel) がドメイン違いなので、Cookie は
// ブラウザによっては送られない。トークン方式ならその制約を受けない。

const { handlePreflight, isLocalOrigin } = require("../lib/cors");
const store = require("../lib/store");
const auth = require("../lib/auth");
const { sendMail, isConfigured: mailConfigured } = require("../lib/mailer");

const DEFAULT_SITE_URL = "http://localhost:3690/";

// 認証の応答は絶対にキャッシュさせない (CDN に他人の応答を配られると困る)
function send(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  // Vercel は JSON の本文を先に読んで req.body に入れてくれる
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 100000) req.destroy();   // 巨大な本文は受け取らない
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.socket?.remoteAddress ||
  "unknown";

// 再設定リンクの宛先。メールに載せるURLなので、リクエストの内容は信用せず
// 「localhost からの開発」か「設定済みの公開URL」かの二択にする。
function siteUrl(req) {
  const origin = req.headers.origin || "";
  if (isLocalOrigin(origin)) return origin + "/";
  return (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/*$/, "/");
}

function resetMailText(url, minutes) {
  return [
    "信用残ウォッチのパスワード再設定のご案内です。",
    "",
    "下のリンクを開いて、新しいパスワードを設定してください。",
    url,
    "",
    `このリンクは ${minutes} 分で使えなくなります。`,
    "心当たりがない場合は、このメールを破棄してください。パスワードは変わりません。",
    "",
    "— 信用残ウォッチ",
  ].join("\n");
}

/* ---------------- 各操作 ---------------- */

async function requireUser(req) {
  const token = bearer(req);
  const user = await auth.sessionUser(token);
  return { token, user };
}

async function handleRegister(req, res, body) {
  const { user, error, status } = await auth.register(body.email, body.password, clientIp(req));
  if (error) return send(res, { error }, status || 400);
  const token = await auth.createSession(user);
  return send(res, { token, user: auth.publicUser(user) });
}

async function handleLogin(req, res, body) {
  const { user, error, status } = await auth.login(body.email, body.password, clientIp(req));
  if (error) return send(res, { error }, status || 400);
  const token = await auth.createSession(user);
  return send(res, { token, user: auth.publicUser(user) });
}

async function handleForgot(req, res, body) {
  const issued = await auth.createResetToken(body.email, clientIp(req));

  // 「登録が無い」ことを応答から読み取れないよう、結果によらず同じ内容を返す
  // (登録済みのアドレス一覧を外から集められるのを防ぐ)
  const ok = {
    ok: true,
    message: "登録済みのメールアドレスであれば、再設定用のリンクを送信しました。メールをご確認ください",
  };
  if (!issued) return send(res, ok);

  const url = siteUrl(req) + "?reset=" + encodeURIComponent(issued.token);
  try {
    const result = await sendMail({
      to: issued.user.email,
      subject: "【信用残ウォッチ】パスワード再設定のご案内",
      text: resetMailText(url, issued.expiresInMin),
    });
    // メール未設定の開発中は、画面から続きを試せるようにリンクを返す
    if (!result.sent) {
      return send(res, {
        ...ok,
        devResetUrl: url,
        message:
          "メール送信が未設定のため、再設定リンクをこの画面に表示しています (開発用)",
      });
    }
  } catch (e) {
    // 送信できなかったことは隠さない。設定ミスに気付けないほうが困るため。
    // (この応答だけは登録済みのアドレスにしか返らないが、実害より実用を取る)
    console.error("再設定メールの送信に失敗しました:", e.message);
    return send(res, { error: "メールを送信できませんでした: " + e.message }, 502);
  }
  return send(res, ok);
}

async function handleReset(req, res, body) {
  const { user, error, status } = await auth.resetPassword(body.token, body.password);
  if (error) return send(res, { error }, status || 400);
  // 変更後はそのままログイン状態にする
  const token = await auth.createSession(user);
  return send(res, { token, user: auth.publicUser(user), message: "パスワードを変更しました" });
}

/* ---------------- 入口 ---------------- */

module.exports = async (req, res) => {
  if (handlePreflight(req, res, { restrict: true })) return;

  const url = new URL(req.url, "http://localhost");
  const action = (url.searchParams.get("action") || "").toLowerCase();

  if (!store.isReady()) {
    return send(res, { error: store.NOT_READY_MESSAGE, unavailable: true }, 503);
  }

  try {
    // 参照だけの操作
    if (req.method === "GET") {
      const { user } = await requireUser(req);
      if (action === "me") {
        return send(res, user ? { user: auth.publicUser(user) } : { user: null });
      }
      if (action === "history") {
        if (!user) return send(res, { error: "ログインしてください" }, 401);
        return send(res, { history: await auth.getHistory(user.id) });
      }
      return send(res, { error: "不明な操作です" }, 400);
    }

    if (req.method !== "POST") {
      return send(res, { error: "許可されていないメソッドです" }, 405);
    }

    const body = await readBody(req);

    if (action === "register") return handleRegister(req, res, body);
    if (action === "login") return handleLogin(req, res, body);
    if (action === "forgot") return handleForgot(req, res, body);
    if (action === "reset") return handleReset(req, res, body);

    if (action === "logout") {
      await auth.destroySession(bearer(req));
      return send(res, { ok: true });
    }

    // ここから先はログインが要る操作
    const { user } = await requireUser(req);
    if (!user) return send(res, { error: "ログインしてください" }, 401);

    if (action === "history-add") {
      return send(res, { history: await auth.addHistory(user.id, body.code, body.name) });
    }
    if (action === "history-remove") {
      return send(res, { history: await auth.removeHistory(user.id, body.code) });
    }
    if (action === "history-clear") {
      return send(res, { history: await auth.clearHistory(user.id) });
    }

    return send(res, { error: "不明な操作です" }, 400);
  } catch (err) {
    console.error(err);
    return send(res, { error: "サーバー内部エラー: " + err.message }, 500);
  }
};

// 設定状況の確認用 (server.js の起動メッセージから使う)
module.exports.status = () => ({
  storage: store.describe(),
  mail: mailConfigured() ? "smtp" : "none",
});
