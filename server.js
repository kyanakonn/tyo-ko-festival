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
    (timestamp) =>
      now - timestamp < DEVICE_SHARE_WINDOW_MS
  );

  if (validHistory.length === 0) {
    deviceShareHistory.delete(voterId);
    return [];
  }

  deviceShareHistory.set(
    voterId,
    validHistory
  );

  return validHistory;
}


/**
 * デバイスごとの共有制限状態を取得
 */
function getDeviceShareLimitState(
  voterId,
  now = nowMs()
) {
  const normalizedVoterId =
    normalizeVoterId(voterId);

  if (!normalizedVoterId) {
    return {
      limited: false,
      remaining: DEVICE_SHARE_LIMIT,
      retryAfterMs: 0,
      limit: DEVICE_SHARE_LIMIT,
      windowMs: DEVICE_SHARE_WINDOW_MS,
    };
  }

  const history =
    pruneDeviceShareHistory(
      normalizedVoterId,
      now
    );

  if (history.length < DEVICE_SHARE_LIMIT) {
    return {
      limited: false,
      remaining:
        DEVICE_SHARE_LIMIT -
        history.length,
      retryAfterMs: 0,
      limit: DEVICE_SHARE_LIMIT,
      windowMs: DEVICE_SHARE_WINDOW_MS,
    };
  }

  const oldestTimestamp =
    history[0];

  const retryAfterMs =
    Math.max(
      0,
      oldestTimestamp +
        DEVICE_SHARE_WINDOW_MS -
        now
    );

  return {
    limited: true,
    remaining: 0,
    retryAfterMs,
    limit: DEVICE_SHARE_LIMIT,
    windowMs: DEVICE_SHARE_WINDOW_MS,
  };
}


/**
 * デバイス共有履歴を記録
 */
function recordDeviceShare(
  voterId,
  now = nowMs()
) {
  const normalizedVoterId =
    normalizeVoterId(voterId);

  if (!normalizedVoterId) {
    return;
  }

  const history =
    pruneDeviceShareHistory(
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
   混雑データをオブジェクト化
========================================= */

function getCrowdDataObject() {
  const result = {};

  for (
    const [
      roomId,
      data
    ] of crowdData.entries()
  ) {
    result[roomId] = data;
  }

  return result;
}


/* =========================================
   SSE
========================================= */

function sendSseEvent(
  client,
  eventName,
  data
) {
  try {
    client.write(
      `event: ${eventName}\n`
    );

    client.write(
      `data: ${JSON.stringify(data)}\n\n`
    );
  } catch (error) {
    sseClients.delete(client);
  }
}


function broadcastCrowdUpdate() {
  const payload = {
    type: "crowd-update",
    data: getCrowdDataObject(),
    updatedAt:
      new Date().toISOString(),
  };

  for (
    const client of sseClients
  ) {
    sendSseEvent(
      client,
      "crowd-update",
      payload
    );
  }
}


/* =========================================
   管理者トークン
========================================= */

function getAdminToken(req) {
  const authorization =
    typeof req.headers.authorization ===
    "string"
      ? req.headers.authorization.trim()
      : "";

  if (
    authorization
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return "";
}


/* =========================================
   管理者認証
========================================= */

function isAdminAuthorized(req) {
  const token =
    getAdminToken(req);

  if (token) {
    const session =
      adminSessions.get(token);

    if (!session) {
      return false;
    }

    if (
      Date.now() -
        session.createdAt >
      ADMIN_SESSION_TTL_MS
    ) {
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
    password ===
      ADMIN_PASSWORD
  );
}


/* =========================================
   ヘルスチェック
========================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      message:
        "長高祭 混雑情報サーバー is running",
    });
  }
);


app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      timestamp:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   ★ 公開設定取得
========================================= */

app.get(
  "/api/crowd/settings",
  (req, res) => {

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

      hiddenIds:
        Array.from(hiddenIds),
    });
  }
);


/* =========================================
   混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    const voterId =
      normalizeVoterId(
        req.query?.voterId
      );

    const deviceLimitState =
      getDeviceShareLimitState(
        voterId
      );

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

      data:
        getCrowdDataObject(),

      updatedAt:
        new Date().toISOString(),

      shareLimit: {
        limited:
          deviceLimitState.limited,

        remaining:
          deviceLimitState.remaining,

        retryAfterMs:
          deviceLimitState.retryAfterMs,

        limit:
          deviceLimitState.limit,

        windowMs:
          deviceLimitState.windowMs,
      },
    });
  }
);


/* =========================================
   デバイスごとの共有制限状態
========================================= */

app.get(
  "/api/crowd/limit",
  (req, res) => {

    const voterId =
      normalizeVoterId(
        req.query?.voterId
      );

    const state =
      getDeviceShareLimitState(
        voterId
      );

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

      limited:
        state.limited,

      remaining:
        state.remaining,

      retryAfterMs:
        state.retryAfterMs,

      limit:
        state.limit,

      windowMs:
        state.windowMs,
    });
  }
);


/* =========================================
   混雑情報 SSE
========================================= */

app.get(
  "/api/crowd/stream",
  (req, res) => {

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

    if (
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    const client = res;

    sseClients.add(client);

    sendSseEvent(
      client,
      "crowd-update",
      {
        type:
          "crowd-update",

        data:
          getCrowdDataObject(),

        updatedAt:
          new Date().toISOString(),
      }
    );

    const heartbeat =
      setInterval(
        () => {
          try {
            client.write(
              ": heartbeat\n\n"
            );
          } catch (error) {
            clearInterval(
              heartbeat
            );
          }
        },
        25000
      );

    req.on(
      "close",
      () => {
        clearInterval(
          heartbeat
        );

        sseClients.delete(
          client
        );
      }
    );
  }
);


/* =========================================
   混雑情報共有
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {

    const body =
      req.body || {};

    const roomId =
      typeof body.roomId ===
      "string"
        ? body.roomId.trim()
        : "";

    const status =
      typeof body.status ===
      "string"
        ? body.status.trim()
        : "";

    const voterId =
      normalizeVoterId(
        body.voterId
      );

    const now =
      nowMs();


    /* -----------------------------------------
       必須項目確認
    ----------------------------------------- */

    if (!roomId) {
      return res.status(400).json({
        ok: false,

        message:
          "roomIdが指定されていません。",

        reason:
          "room-id-required",
      });
    }


    if (!status) {
      return res.status(400).json({
        ok: false,

        message:
          "statusが指定されていません。",

        reason:
          "status-required",
      });
    }


    if (!voterId) {
      return res.status(400).json({
        ok: false,

        message:
          "voterIdが指定されていません。",

        reason:
          "voter-id-required",
      });
    }


    /* -----------------------------------------
       デバイス共有制限
    ----------------------------------------- */

    const limitState =
      getDeviceShareLimitState(
        voterId,
        now
      );

    if (limitState.limited) {

      return res.status(429).json({
        ok: false,

        message:
          "この端末の共有上限に達しています。",

        error:
          "この端末の共有上限に達しています。",

        reason:
          "device-share-limit",

        limited: true,

        remaining:
          0,

        retryAfterMs:
          limitState.retryAfterMs,

        limit:
          DEVICE_SHARE_LIMIT,

        windowMs:
          DEVICE_SHARE_WINDOW_MS,
      });
    }


    /* -----------------------------------------
       同一カードの連続投稿防止
    ----------------------------------------- */

    const existing =
      crowdData.get(roomId);

    if (
      existing &&
      existing.voterId === voterId &&
      Number.isFinite(
        existing.updatedAtMs
      )
    ) {

      const elapsed =
        now -
        existing.updatedAtMs;

      if (
        elapsed <
        SAME_CARD_COOLDOWN_MS
      ) {

        const retryAfterMs =
          SAME_CARD_COOLDOWN_MS -
          elapsed;

        return res.status(429).json({
          ok: false,

          message:
            "このカードは前回の共有から5分間は再共有できません。",

          error:
            "このカードは前回の共有から5分間は再共有できません。",

          reason:
            "same-card-cooldown",

          retryAfterMs,
        });
      }
    }


    /* -----------------------------------------
       混雑データ保存
    ----------------------------------------- */

    const record = {

      roomId,

      status,

      voterId,

      updatedAt:
        new Date(now)
          .toISOString(),

      updatedAtMs:
        now,
    };


    crowdData.set(
      roomId,
      record
    );


    /* -----------------------------------------
       デバイス共有履歴記録
    ----------------------------------------- */

    recordDeviceShare(
      voterId,
      now
    );


    /* -----------------------------------------
       SSE通知
    ----------------------------------------- */

    broadcastCrowdUpdate();


    const newLimitState =
      getDeviceShareLimitState(
        voterId,
        now
      );


    return res.json({
      ok: true,

      data: record,

      shareLimit: {
        limited:
          newLimitState.limited,

        remaining:
          newLimitState.remaining,

        retryAfterMs:
          newLimitState.retryAfterMs,

        limit:
          newLimitState.limit,

        windowMs:
          newLimitState.windowMs,
      },
    });
  }
);


/* =========================================
   管理者ログイン
========================================= */

app.post(
  "/api/admin/login",
  (req, res) => {

    const password =
      typeof req.body?.password ===
      "string"
        ? req.body.password
        : "";

    if (
      !ADMIN_PASSWORD ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "パスワードが正しくありません。",
      });
    }

    const token =
      crypto.randomBytes(32)
        .toString("hex");

    adminSessions.set(
      token,
      {
        createdAt:
          Date.now(),
      }
    );

    return res.json({
      ok: true,

      token,
    });
  }
);


/* =========================================
   管理者ログアウト
========================================= */

app.post(
  "/api/admin/logout",
  (req, res) => {

    const token =
      getAdminToken(req);

    if (token) {
      adminSessions.delete(
        token
      );
    }

    return res.json({
      ok: true,
    });
  }
);


/* =========================================
   管理者状態取得
========================================= */

app.get(
  "/api/admin/state",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    return res.json({
      ok: true,

      sharingEnabled,

      hiddenIds:
        Array.from(hiddenIds),

      crowd:
        getCrowdDataObject(),

      updatedAt:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   管理者 共有機能切り替え
========================================= */

app.post(
  "/api/admin/sharing",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    sharingEnabled =
      req.body?.enabled !== false;

    return res.json({
      ok: true,

      sharingEnabled,

      updatedAt:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   管理者 カード非表示
========================================= */

app.post(
  "/api/admin/card/hide",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    const id =
      typeof req.body?.id ===
      "string"
        ? req.body.id.trim()
        : "";

    if (!id) {
      return res.status(400).json({
        ok: false,

        error:
          "idが指定されていません。",
      });
    }

    hiddenIds.add(id);

    return res.json({
      ok: true,

      hiddenIds:
        Array.from(hiddenIds),

      updatedAt:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   管理者 カード復元
========================================= */

app.post(
  "/api/admin/card/restore",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    const id =
      typeof req.body?.id ===
      "string"
        ? req.body.id.trim()
        : "";

    if (!id) {
      return res.status(400).json({
        ok: false,

        error:
          "idが指定されていません。",
      });
    }

    hiddenIds.delete(id);

    return res.json({
      ok: true,

      hiddenIds:
        Array.from(hiddenIds),

      updatedAt:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   管理者 混雑状況取得
========================================= */

app.get(
  "/api/admin/crowd",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    return res.json({
      ok: true,

      crowd:
        getCrowdDataObject(),

      hiddenIds:
        Array.from(hiddenIds),

      sharingEnabled,
    });
  }
);


/* =========================================
   管理者 混雑状況リセット
========================================= */

app.post(
  "/api/admin/crowd/reset",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    crowdData.clear();

    hiddenIds.clear();

    deviceShareHistory.clear();

    broadcastCrowdUpdate();

    return res.json({
      ok: true,

      message:
        "混雑状況をリセットしました。",

      crowd: {},

      hiddenIds: [],

      sharingEnabled,
    });
  }
);


/* =========================================
   管理者 共有制限リセット
========================================= */

app.post(
  "/api/admin/crowd/limit/reset",
  (req, res) => {

    if (
      !isAdminAuthorized(req)
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "管理者認証に失敗しました。",
      });
    }

    deviceShareHistory.clear();

    return res.json({
      ok: true,

      message:
        "共有制限をリセットしました。",
    });
  }
);


/* =========================================
   混雑情報削除
========================================= */

app.delete(
  "/api/crowd/:roomId",
  (req, res) => {

    const roomId =
      typeof req.params.roomId ===
      "string"
        ? req.params.roomId.trim()
        : "";

    if (!roomId) {
      return res.status(400).json({
        ok: false,

        error:
          "roomIdが指定されていません。",
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
    });
  }
);


/* =========================================
   404
========================================= */

app.use(
  (req, res) => {

    res.status(404).json({
      ok: false,

      error:
        "Not Found",
    });
  }
);


/* =========================================
   エラーハンドリング
========================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(error);

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        "サーバー内部でエラーが発生しました。",
    });
  }
);


/* =========================================
   サーバー起動
========================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
