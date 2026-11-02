// メール送信 (パスワード再設定用)。
//
// 追加パッケージを入れずに済ませるため、Node 標準の net/tls で SMTP を直接話す。
// 対応しているのは個人利用で必要な範囲だけ:
//   - 465 番の暗黙 TLS / 587 番の STARTTLS
//   - AUTH LOGIN と AUTH PLAIN
//   - 本文はプレーンテキスト (UTF-8 を base64 で送るので日本語もそのまま通る)
//
// SMTP_HOST が未設定のときは送信せず、再設定URLをサーバーのログに出す。
// 開発中はこれで一連の流れを確認できる。

const net = require("net");
const tls = require("tls");

const CONNECT_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 15000;

function config() {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT) || 465;
  // 465 は接続した時点で TLS、587 は平文で始めて STARTTLS で切り替えるのが通例
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE !== "false"
    : port === 465;
  return {
    host,
    port,
    secure,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    fromName: process.env.SMTP_FROM_NAME || "信用残ウォッチ",
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.host && c.from);
}

/* ---------------- SMTP の会話 ---------------- */

// 応答は複数行になることがある ("250-XXX" が続き、最後だけ "250 XXX")。
// 最終行が来るまで待ってから、コード付きでまとめて返す。
function createConversation(socket) {
  let buffer = "";
  let waiting = null;
  let closed = null;

  const flush = () => {
    if (!waiting) return;
    const lines = buffer.split("\r\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\d{3} /.test(line)) {
        buffer = lines.slice(i + 1).join("\r\n");
        const w = waiting;
        waiting = null;
        w.resolve({ code: Number(line.slice(0, 3)), text: lines.slice(0, i + 1).join("\n") });
        return;
      }
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });
  const fail = (err) => {
    closed = err;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.reject(err);
    }
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP サーバーとの接続が切れました")));

  return {
    read() {
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => fail(new Error("SMTP サーバーの応答がありません")),
          COMMAND_TIMEOUT_MS
        );
        const done = (fn) => (v) => {
          clearTimeout(timer);
          fn(v);
        };
        waiting = { resolve: done(resolve), reject: done(reject) };
        flush();
      });
    },
    send(line) {
      socket.write(line + "\r\n");
    },
    // 応答コードが期待通りでなければ、サーバーの文言をそのままエラーにする
    async expect(codes, what) {
      const res = await this.read();
      if (!codes.includes(res.code)) {
        throw new Error(`SMTP ${what} が拒否されました: ${res.text.split("\n").pop()}`);
      }
      return res;
    },
  };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
    const socket = cfg.secure ? tls.connect(opts) : net.connect(opts);
    const onReady = () => {
      // 接続後の待ち時間は会話側 (COMMAND_TIMEOUT_MS) で見るので解除する
      socket.setTimeout(0);
      // 会話側が拾うまでの隙間に error が来てもプロセスを落とさない
      socket.on("error", () => {});
      socket.removeListener("error", reject);
      resolve(socket);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("SMTP サーバーに接続できませんでした (タイムアウト)"));
    });
    socket.once("error", reject);
    socket.once(cfg.secure ? "secureConnect" : "connect", onReady);
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.on("error", () => {});
      secure.removeListener("error", reject);
      resolve(secure);
    });
    secure.once("error", reject);
  });
}

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

// 日本語の件名は RFC 2047 のエンコードが要る (生の UTF-8 だと文字化けする)
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function buildMessage(cfg, { to, subject, text }) {
  const headers = [
    `From: ${encodeHeader(cfg.fromName)} <${cfg.from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${cfg.from.split("@")[1] || "localhost"}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  // base64 は行の先頭が "." にならないので、DATA のドット処理は不要
  const body = b64(text).replace(/(.{76})/g, "$1\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + body;
}

async function smtpSend(cfg, mail) {
  let socket = await connect(cfg);
  let conv = createConversation(socket);

  try {
    await conv.expect([220], "接続");
    conv.send("EHLO kabu-shinyo-watch");
    let hello = await conv.expect([250], "EHLO");

    if (!cfg.secure && /STARTTLS/i.test(hello.text)) {
      conv.send("STARTTLS");
      await conv.expect([220], "STARTTLS");
      socket.removeAllListeners("data");
      socket = await upgradeToTls(socket, cfg.host);
      conv = createConversation(socket);
      conv.send("EHLO kabu-shinyo-watch");
      hello = await conv.expect([250], "EHLO");
    }

    if (cfg.user) {
      if (/AUTH[ =-].*PLAIN/i.test(hello.text)) {
        conv.send("AUTH PLAIN " + b64(`\0${cfg.user}\0${cfg.pass}`));
        await conv.expect([235], "認証");
      } else {
        conv.send("AUTH LOGIN");
        await conv.expect([334], "認証");
        conv.send(b64(cfg.user));
        await conv.expect([334], "認証(ユーザー名)");
        conv.send(b64(cfg.pass));
        await conv.expect([235], "認証(パスワード)");
      }
    }

    conv.send(`MAIL FROM:<${cfg.from}>`);
    await conv.expect([250], "MAIL FROM");
    conv.send(`RCPT TO:<${mail.to}>`);
    await conv.expect([250, 251], "RCPT TO");
    conv.send("DATA");
    await conv.expect([354], "DATA");
    socket.write(buildMessage(cfg, mail) + "\r\n.\r\n");
    await conv.expect([250], "本文の送信");
    conv.send("QUIT");
  } finally {
    socket.destroy();
  }
}

// 送信できたら { sent: true }、SMTP 未設定なら { sent: false } を返す。
// 送信自体に失敗した場合は例外を投げる (呼び出し側で握りつぶすかは用途次第)。
async function sendMail(mail) {
  const cfg = config();
  if (!cfg.host || !cfg.from) {
    console.log("");
    console.log("  [メール未設定] 次の内容を送信するはずでした");
    console.log(`  宛先  : ${mail.to}`);
    console.log(`  件名  : ${mail.subject}`);
    console.log("  ------------------------------------------");
    console.log(mail.text.split("\n").map((l) => "  " + l).join("\n"));
    console.log("  ------------------------------------------");
    console.log("");
    return { sent: false };
  }
  await smtpSend(cfg, mail);
  return { sent: true };
}

module.exports = { sendMail, isConfigured };
