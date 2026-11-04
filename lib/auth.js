// アカウント (登録・ログイン・パスワード再設定・検索履歴) のロジック。
// 保存先の違いは lib/store.js が吸収するので、ここは中身だけを扱う。

const crypto = require("crypto");
const { promisify } = require("util");
const store = require("./store");

const scrypt = promisify(crypto.scrypt);

const SESSION_TTL_SEC = 60 * 60 * 24 * 30;   // ログイン状態は30日
const RESET_TTL_SEC = 60 * 30;               // 再設定リンクは30分で失効
const HISTORY_MAX = 50;                      // 検索履歴の保持件数
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// scrypt のパラメータ。N を上げるほど総当たりに強くなるが、
// サーバーレスの実行時間も伸びる。16384 で 1回あたり数十ミリ秒。
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------------- パスワード ---------------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // 既定のメモリ上限 (32MB) だと N=16384 で足りないので明示的に広げる
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString("base64"), key.toString("base64"),
  ].join("$");
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const key = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    // 比較時間からパスワードの手がかりが漏れないようにする
    return crypto.timingSafeEqual(key, expected);
  } catch (e) {
    return false;
  }
}

/* ---------------- 入力チェック ---------------- */

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function emailError(email) {
  if (!email) return "メールアドレスを入力してください";
  if (email.length > 254) return "メールアドレスが長すぎます";
  // 正確な RFC 準拠より、打ち間違いを弾いて実在確認はメール到達に任せる方が実用的
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    return "メールアドレスの形式が正しくありません";
  }
  return null;
}

function passwordError(password) {
  const pw = String(password || "");
  if (pw.length < PASSWORD_MIN) return `パスワードは${PASSWORD_MIN}文字以上にしてください`;
  if (pw.length > PASSWORD_MAX) return `パスワードは${PASSWORD_MAX}文字以内にしてください`;
  return null;
}

/* ---------------- トークン ----------------
   トークンそのものは保存せず、SHA-256 だけを鍵にする。
   保存先の中身が漏れてもセッションを乗っ取られない。 */

const newToken = () => crypto.randomBytes(32).toString("base64url");
const tokenKey = (prefix, token) =>
  prefix + crypto.createHash("sha256").update(String(token)).digest("hex");

/* ---------------- 回数制限 ----------------
   総当たりと、他人のアドレスへの再設定メール連投を抑える。
   保存先が一時的に不調なときは制限をあきらめる (ログインまで止めないため)。 */

// 1回ぶん数えて、上限を超えたら true
async function tooManyAttempts(bucket, limit, ttlSec) {
  try {
    return (await store.incr("rl:" + bucket, ttlSec)) > limit;
  } catch (e) {
    return false;
  }
}

// 数えずに今の回数だけ見る (ログインは失敗したときだけ数えたいので分けている)
async function alreadyOverLimit(bucket, limit) {
  try {
    return Number(await store.get("rl:" + bucket)) >= limit;
  } catch (e) {
    return false;
  }
}

async function countAttempt(bucket, ttlSec) {
  try {
    await store.incr("rl:" + bucket, ttlSec);
  } catch (e) { /* 数えられなくても処理は続ける */ }
}

/* ---------------- ユーザー ---------------- */

const userKey = (email) => "user:" + email;

async function getUser(email) {
  return store.get(userKey(normalizeEmail(email)));
}

// 成功: { user }  失敗: { error }
async function register(emailRaw, password, ip) {
  const email = normalizeEmail(emailRaw);
  const err = emailError(email) || passwordError(password);
  if (err) return { error: err };

  if (await tooManyAttempts(`reg:${ip}`, 10, 60 * 60)) {
    return { error: "登録の試行が多すぎます。しばらくしてからお試しください", status: 429 };
  }

  const user = {
    id: crypto.randomUUID(),
    email,
    pass: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  // 同じアドレスで同時に登録されても、先に書けた方だけが成功する
  if (!(await store.setIfAbsent(userKey(email), user))) {
    return { error: "このメールアドレスは既に登録されています", status: 409 };
  }
  return { user };
}

async function login(emailRaw, password, ip) {
  const email = normalizeEmail(emailRaw);
  if (!email || !password) return { error: "メールアドレスとパスワードを入力してください" };

  // 成功したログインは数えない (正しく使っている人を締め出さないため)
  const bucket = `login:${ip}:${email}`;
  if (await alreadyOverLimit(bucket, 10)) {
    return { error: "ログインの失敗が続いています。15分ほど待ってからお試しください", status: 429 };
  }

  const user = await store.get(userKey(email));
  // 「アドレスが無い」と「パスワードが違う」を区別すると、登録の有無が分かってしまう
  if (!user || !(await verifyPassword(password, user.pass))) {
    await countAttempt(bucket, 60 * 15);
    return { error: "メールアドレスまたはパスワードが違います", status: 401 };
  }
  return { user };
}

/* ---------------- セッション ---------------- */

async function createSession(user) {
  const token = newToken();
  await store.set(
    tokenKey("session:", token),
    { uid: user.id, email: user.email, createdAt: Date.now() },
    SESSION_TTL_SEC
  );
  return token;
}

async function sessionUser(token) {
  if (!token) return null;
  const sess = await store.get(tokenKey("session:", token));
  if (!sess) return null;
  const user = await store.get(userKey(sess.email));
  if (!user) return null;
  // パスワード変更より前のログインは無効にする (盗まれたトークンを使えなくするため)
  if (user.passwordChangedAt && sess.createdAt < Date.parse(user.passwordChangedAt)) return null;
  return user;
}

async function destroySession(token) {
  if (token) await store.del(tokenKey("session:", token));
}

/* ---------------- パスワード再設定 ---------------- */

// 登録が無くても呼び出し側には同じ応答を返させたいので、
// 「登録が無い」ケースは null を返すだけにする (エラーにしない)。
async function createResetToken(emailRaw, ip) {
  const email = normalizeEmail(emailRaw);
  if (emailError(email)) return null;
  if (await tooManyAttempts(`forgot:${ip}`, 5, 60 * 60)) return null;
  if (await tooManyAttempts(`forgot:${email}`, 5, 60 * 60)) return null;

  const user = await store.get(userKey(email));
  if (!user) return null;

  const token = newToken();
  await store.set(tokenKey("reset:", token), { email }, RESET_TTL_SEC);
  return { token, user, expiresInMin: RESET_TTL_SEC / 60 };
}

async function resetPassword(token, newPassword) {
  const err = passwordError(newPassword);
  if (err) return { error: err };

  const key = tokenKey("reset:", token);
  const rec = await store.get(key);
  if (!rec) {
    return { error: "この再設定リンクは無効か、有効期限が切れています", status: 400 };
  }
  const user = await store.get(userKey(rec.email));
  if (!user) return { error: "アカウントが見つかりません", status: 400 };

  user.pass = await hashPassword(newPassword);
  user.passwordChangedAt = new Date().toISOString();
  await store.set(userKey(user.email), user);
  // 使い捨て。同じリンクで二度は変更できない
  await store.del(key);
  return { user };
}

/* ---------------- 検索履歴 ---------------- */

const historyKey = (uid) => "history:" + uid;

async function getHistory(uid) {
  const list = await store.get(historyKey(uid));
  return Array.isArray(list) ? list : [];
}

// 同じ銘柄は先頭に繰り上げ、重複させない
async function addHistory(uid, code, name) {
  const entry = {
    code: String(code || "").toUpperCase().slice(0, 8),
    name: String(name || "").slice(0, 60),
    at: new Date().toISOString(),
  };
  if (!entry.code) return [];
  const list = (await getHistory(uid)).filter((h) => h.code !== entry.code);
  list.unshift(entry);
  const trimmed = list.slice(0, HISTORY_MAX);
  await store.set(historyKey(uid), trimmed);
  return trimmed;
}

async function removeHistory(uid, code) {
  const list = (await getHistory(uid)).filter(
    (h) => h.code !== String(code || "").toUpperCase()
  );
  await store.set(historyKey(uid), list);
  return list;
}

async function clearHistory(uid) {
  await store.del(historyKey(uid));
  return [];
}

// 画面に返すユーザー情報 (パスワードハッシュは絶対に含めない)
const publicUser = (user) => ({ email: user.email, createdAt: user.createdAt });

module.exports = {
  register, login,
  createSession, sessionUser, destroySession,
  createResetToken, resetPassword,
  getHistory, addHistory, removeHistory, clearHistory,
  getUser, publicUser,
  RESET_TTL_SEC, HISTORY_MAX, PASSWORD_MIN,
};
