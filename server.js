const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;


/* =========================================
   基本設定
========================================= */

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());


/* =========================================
   管理者設定
========================================= */

const ADMIN_PASSWORD = "hello";

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const hiddenIds = new Set();
let sharingEnabled = false;

/* =========================================
   共有データ
========================================= */

// 部屋ごとの混雑情報
const crowdData = new Map();

// SSE接続中のクライアント
const sseClients = new Set();

// 同一カードの連続投稿防止
const SAME_CARD_COOLDOWN_MS = 5 * 60 * 1000;

// 1デバイスあたりの共有制限
const DEVICE_SHARE_LIMIT = 10;
const DEVICE_SHARE_WINDOW_MS = 10 * 60 * 1000;

// voterIdごとに共有履歴を保持
const deviceShareHistory = new Map();


/* =========================================
   補助関数
========================================= */

function normalizeVoterId(voterId) {
  if (typeof voterId !== "string") {
    return "";
  }

  return voterId.trim();
}


function nowMs() {
  return Date.now();
}


/* =========================================
   デバイスごとの共有制限
========================================= */

/**
 * 古い共有履歴を削除
 */
function pruneDeviceShareHistory(voterId, now = nowMs()) {
  const history = deviceShareHistory.get(voterId);

  if (!history) {
    return [];
  }

  const validHistory = history.filter(
    (timestamp) => now - timestamp < DEVICE_SHARE_WINDOW_MS
  );

  if (validHistory.length === 0) {
    deviceShareHistory.delete(voterId);
    return [];
  }

  deviceShareHistory.set(voterId, validHistory);

  return validHistory;
}


/**
 * デバイスごとの共有制限状態を取得
 */
function getDeviceShareLimitState(voterId, now = nowMs()) {
  const normalizedVoterId = normalizeVoterId(voterId);

  if (!normalizedVoterId) {
    return {
      limited: false,
      remaining: DEVICE_SHARE_LIMIT,
      retryAfterMs: 0,
      limit: DEVICE_SHARE_LIMIT,
      windowMs: DEVICE_SHARE_WINDOW_MS,
    };
  }

  const history = pruneDeviceShareHistory(
    normalizedVoterId,
    now
  );

  const remaining = Math.max(
    0,
    DEVICE_SHARE_LIMIT - history.length
  );

  let retryAfterMs = 0;

  if (history.length >= DEVICE_SHARE_LIMIT) {
    const oldestTimestamp = history[0];

    retryAfterMs = Math.max(
      0,
      oldestTimestamp + DEVICE_SHARE_WINDOW_MS - now
    );
  }

  return {
    limited: remaining <= 0,
    remaining,
    retryAfterMs,
    limit: DEVICE_SHARE_LIMIT,
    windowMs: DEVICE_SHARE_WINDOW_MS,
  };
}


/**
 * デバイスの共有履歴に1回分を記録
 */
function recordDeviceShare(voterId, now = nowMs()) {
  const normalizedVoterId = normalizeVoterId(voterId);

  if (!normalizedVoterId) {
    return;
  }

  const history = pruneDeviceShareHistory(
    normalizedVoterId,
    now
  );

  history.push(now);

  deviceShareHistory.set(
    normalizedVoterId,
    history
  );
}


/* =========================================
   混雑情報データ
========================================= */

function getCrowdDataObject() {
  const result = {};

  for (const [roomId, data] of crowdData.entries()) {
    result[roomId] = {
      ...data,
    };
  }

  return result;
}


/* =========================================
   SSE
========================================= */

function sendSseEvent(client, eventName, data) {
  try {
    client.write(`event: ${eventName}\n`);
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (error) {
    // 接続が切れている場合は無視
  }
}


function broadcastCrowdUpdate() {
  const payload = {
    type: "crowd-update",
    data: getCrowdDataObject(),
    updatedAt: new Date().toISOString(),
  };

  for (const client of sseClients) {
    sendSseEvent(
      client,
      "crowd-update",
      payload
    );
  }
}


/* =========================================
   管理者認証
========================================= */

function getAdminToken(req) {
  const authorization =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}


function isAdminAuthorized(req) {
  const token = getAdminToken(req);

  if (token) {
    const session = adminSessions.get(token);

    if (!session) {
      return false;
    }

    if (Date.now() - session.createdAt > ADMIN_SESSION_TTL_MS) {
      adminSessions.delete(token);
      return false;
    }

    return true;
  }

  const password =
    req.headers["x-admin-password"] ||
    req.body?.password ||
    req.query?.password ||
    "";

  return (
    ADMIN_PASSWORD &&
    password === ADMIN_PASSWORD
  );
}


/* =========================================
   ヘルスチェック
========================================= */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "長高祭 混雑情報サーバー is running",
  });
});


app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});


/* =========================================
   公開設定取得
========================================= */

app.get("/api/crowd/settings", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

  return res.json({
    ok: true,
    sharingEnabled,
    hiddenIds: Array.from(hiddenIds),
  });
});


/* =========================================
   混雑情報取得
========================================= */

app.get("/api/crowd", (req, res) => {
  const voterId = normalizeVoterId(
    req.query?.voterId
  );

  const deviceLimitState =
    getDeviceShareLimitState(voterId);

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

  res.json({
    ok: true,
    data: getCrowdDataObject(),
    updatedAt: new Date().toISOString(),

    shareLimit: {
      limited: deviceLimitState.limited,
      remaining: deviceLimitState.remaining,
      retryAfterMs: deviceLimitState.retryAfterMs,
      limit: deviceLimitState.limit,
      windowMs: deviceLimitState.windowMs,
    },
  });
});


/* =========================================
   デバイスごとの共有制限状態
========================================= */

app.get("/api/crowd/limit", (req, res) => {
  const voterId = normalizeVoterId(
    req.query?.voterId
  );

  const state =
    getDeviceShareLimitState(voterId);

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

  res.json({
    ok: true,

    limited: state.limited,

    remaining: state.remaining,

    retryAfterMs: state.retryAfterMs,

    limit: state.limit,

    windowMs: state.windowMs,
  });
});


/* =========================================
   混雑情報 SSE
========================================= */

app.get("/api/crowd/stream", (req, res) => {
  res.setHeader(
    "Content-Type",
    "text/event-stream"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Accel-Buffering",
    "no"
  );

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const client = res;

  sseClients.add(client);

  sendSseEvent(
    client,
    "crowd-update",
    {
      type: "crowd-update",
      data: getCrowdDataObject(),
      updatedAt: new Date().toISOString(),
    }
  );

  const heartbeat = setInterval(() => {
    try {
      client.write(": heartbeat\n\n");
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});


/* =========================================
   混雑情報共有
========================================= */

app.post("/api/crowd", (req, res) => {
  const body = req.body || {};

  const roomId =
    typeof body.id === "string"
      ? body.id.trim()
      : (
          typeof body.roomId === "string"
            ? body.roomId.trim()
            : ""
        );

  const status =
    typeof body.status === "string"
      ? body.status.trim()
      : "";

  const voterId =
    normalizeVoterId(body.voterId);

  const now = nowMs();


  /* -----------------------------------------
     管理画面の共有設定確認
  ----------------------------------------- */

  if (!sharingEnabled) {
    return res.status(403).json({
      ok: false,
      message:
        "現在、混雑情報の共有は停止されています。",
      error:
        "現在、混雑情報の共有は停止されています。",
      reason:
        "sharing-disabled",
    });
  }


  /* -----------------------------------------
     必須項目確認
  ----------------------------------------- */

  if (!roomId) {
    return res.status(400).json({
      ok: false,
      message: "roomIdが指定されていません。",
      reason: "room-id-required",
    });
  }

  if (!status) {
    return res.status(400).json({
      ok: false,
      message: "混雑状況が指定されていません。",
      reason: "status-required",
    });
  }

  if (!voterId) {
    return res.status(400).json({
      ok: false,
      message:
        "端末識別情報が取得できませんでした。ページを再読み込みしてください。",
      reason: "voter-id-required",
    });
  }


  /* -----------------------------------------
     デバイスごとの共有上限確認
  ----------------------------------------- */

  const deviceLimitState =
    getDeviceShareLimitState(
      voterId,
      now
    );

  if (deviceLimitState.limited) {
    return res.status(429).json({
      ok: false,

      message:
        "この端末の共有上限に達しています。しばらくしてからもう一度お試しください。",

      reason: "device-share-limit",

      retryAfterMs:
        deviceLimitState.retryAfterMs,

      remaining:
        deviceLimitState.remaining,

      limit:
        deviceLimitState.limit,

      windowMs:
        deviceLimitState.windowMs,
    });
  }


  /* -----------------------------------------
     ステータス確認
  ----------------------------------------- */

  const allowedStatuses = [
    "empty",
    "normal",
    "crowded",
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      ok: false,
      message: "無効な混雑状況です。",
      reason: "invalid-status",
    });
  }


  /* -----------------------------------------
     同じカードの連続共有制限
  ----------------------------------------- */

  const existing = crowdData.get(roomId);

  if (
    existing &&
    existing.voterId === voterId &&
    typeof existing.updatedAtMs === "number"
  ) {
    const elapsed =
      now - existing.updatedAtMs;

    if (elapsed < SAME_CARD_COOLDOWN_MS) {
      const remainingMs =
        SAME_CARD_COOLDOWN_MS - elapsed;

      return res.status(429).json({
        ok: false,

        message:
          "同じ場所の共有は、しばらく時間を空けてください。",

        reason: "same-card-cooldown",

        retryAfterMs:
          remainingMs,
      });
    }
  }


  /* -----------------------------------------
     混雑情報を保存
  ----------------------------------------- */

  const updatedAt =
    new Date(now).toISOString();

  const crowdItem = {
    roomId,

    status,

    voterId,

    updatedAt,

    updatedAtMs: now,
  };

  crowdData.set(
    roomId,
    crowdItem
  );


  /* -----------------------------------------
     デバイスの共有履歴を記録
  ----------------------------------------- */

  recordDeviceShare(
    voterId,
    now
  );


  /* -----------------------------------------
     SSEで全クライアントへ通知
  ----------------------------------------- */

  broadcastCrowdUpdate();


  /* -----------------------------------------
     レスポンス
  ----------------------------------------- */

  const updatedLimitState =
    getDeviceShareLimitState(
      voterId,
      now
    );

  return res.json({
    ok: true,

    id: roomId,

    status,

    voterId,

    updatedAt,

    updatedAtMs: now,

    data: crowdItem,

    shareLimit: {
      limited:
        updatedLimitState.limited,

      remaining:
        updatedLimitState.remaining,

      retryAfterMs:
        updatedLimitState.retryAfterMs,

      limit:
        updatedLimitState.limit,

      windowMs:
        updatedLimitState.windowMs,
    },
  });
});


/* =========================================
   特定の混雑情報削除
========================================= */

app.delete("/api/crowd/:roomId", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      message: "管理者認証に失敗しました。",
    });
  }

  const roomId =
    typeof req.params.roomId === "string"
      ? req.params.roomId.trim()
      : "";

  if (!roomId) {
    return res.status(400).json({
      ok: false,
      message: "roomIdが指定されていません。",
    });
  }

  const deleted =
    crowdData.delete(roomId);

  if (deleted) {
    broadcastCrowdUpdate();
  }

  return res.json({
    ok: true,
    deleted,
    data: getCrowdDataObject(),
  });
});


/* =========================================
   管理者ログイン
========================================= */

app.post("/api/admin/login", (req, res) => {
  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (
    !ADMIN_PASSWORD ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      ok: false,
      error: "パスワードが正しくありません。",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  adminSessions.set(token, {
    createdAt: Date.now(),
  });

  return res.json({
    ok: true,
    token,
  });
});


/* =========================================
   管理者ログアウト
========================================= */

app.post("/api/admin/logout", (req, res) => {
  const token = getAdminToken(req);

  if (token) {
    adminSessions.delete(token);
  }

  return res.json({
    ok: true,
  });
});


/* =========================================
   管理者状態取得
========================================= */

app.get("/api/admin/state", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "管理者認証に失敗しました。",
    });
  }

  return res.json({
    ok: true,
    sharingEnabled,
    hiddenIds: Array.from(hiddenIds),
    crowd: getCrowdDataObject(),
    updatedAt: new Date().toISOString(),
  });
});


/* =========================================
   管理者 共有機能切り替え
========================================= */

app.post("/api/admin/sharing", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "管理者認証に失敗しました。",
    });
  }

  sharingEnabled =
    req.body?.enabled !== false;

  return res.json({
    ok: true,
    sharingEnabled,
    updatedAt: new Date().toISOString(),
  });
});


/* =========================================
   管理者 カード非表示
========================================= */

app.post("/api/admin/card/hide", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "管理者認証に失敗しました。",
    });
  }

  const id =
    typeof req.body?.id === "string"
      ? req.body.id.trim()
      : "";

  if (!id) {
    return res.status(400).json({
      ok: false,
      error: "idが指定されていません。",
    });
  }

  hiddenIds.add(id);

  return res.json({
    ok: true,
    hiddenIds: Array.from(hiddenIds),
    updatedAt: new Date().toISOString(),
  });
});


/* =========================================
   管理者 カード復元
========================================= */

app.post("/api/admin/card/restore", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "管理者認証に失敗しました。",
    });
  }

  const id =
    typeof req.body?.id === "string"
      ? req.body.id.trim()
      : "";

  if (!id) {
    return res.status(400).json({
      ok: false,
      error: "idが指定されていません。",
    });
  }

  hiddenIds.delete(id);

  return res.json({
    ok: true,
    hiddenIds: Array.from(hiddenIds),
    updatedAt: new Date().toISOString(),
  });
});


/* =========================================
   管理者用 全データ取得
========================================= */

app.get("/api/admin/crowd", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      message: "管理者認証に失敗しました。",
    });
  }

  return res.json({
    ok: true,
    data: getCrowdDataObject(),
    updatedAt: new Date().toISOString(),
  });
});


/* =========================================
   管理者用 混雑情報リセット
========================================= */

app.post("/api/admin/crowd/reset", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      message: "管理者認証に失敗しました。",
    });
  }


  /* -----------------------------------------
     混雑情報を全削除
  ----------------------------------------- */

  crowdData.clear();
  hiddenIds.clear();


  /* -----------------------------------------
     デバイスごとの共有履歴もリセット
  ----------------------------------------- */

  deviceShareHistory.clear();


  /* -----------------------------------------
     全クライアントへ通知
  ----------------------------------------- */

  broadcastCrowdUpdate();


  return res.json({
    ok: true,

    message:
      "混雑情報と共有制限をリセットしました。",

    data: getCrowdDataObject(),

    updatedAt:
      new Date().toISOString(),
  });
});


/* =========================================
   管理者用 共有制限リセット
========================================= */

app.post("/api/admin/crowd/limit/reset", (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      message: "管理者認証に失敗しました。",
    });
  }

  deviceShareHistory.clear();

  return res.json({
    ok: true,

    message:
      "すべての端末の共有制限をリセットしました。",

    updatedAt:
      new Date().toISOString(),
  });
});


/* =========================================
   404
========================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: "指定されたAPIが見つかりません。",
  });
});


/* =========================================
   エラーハンドリング
========================================= */

app.use((error, req, res, next) => {
  console.error(
    "Server Error:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    ok: false,
    message:
      "サーバー内部でエラーが発生しました。",
  });
});


/* =========================================
   サーバー起動
========================================= */

app.listen(PORT, () => {
  console.log(
    `Server is running on port ${PORT}`
  );
});
