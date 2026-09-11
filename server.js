const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;


/* =========================================
   基本設定
========================================= */

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);


/* =========================================
   管理パスワード
========================================= */

const ADMIN_PASSWORD = "hello";

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const hiddenIds = new Set();
let sharingEnabled = false;


/* =========================================
   混雑データ
========================================= */

const crowdData = new Map();


/* =========================================
   デバイスごとの共有履歴
========================================= */

const deviceShareHistory = new Map();

const DEVICE_SHARE_LIMIT = 10;
const DEVICE_SHARE_WINDOW_MS =
  10 * 60 * 1000;


/* =========================================
   安全な文字列
========================================= */

function safeString(
  value,
  fallback = ""
) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  const text =
    String(value).trim();

  if (
    !text ||
    text === "undefined" ||
    text === "null"
  ) {
    return fallback;
  }

  return text;
}


/* =========================================
   デバイス共有履歴の整理
========================================= */

function pruneDeviceShareHistory(
  voterId
) {
  const now = Date.now();

  const history =
    deviceShareHistory.get(voterId) || [];

  const validHistory =
    history.filter(
      timestamp =>
        now - timestamp <
        DEVICE_SHARE_WINDOW_MS
    );

  if(validHistory.length > 0){
    deviceShareHistory.set(
      voterId,
      validHistory
    );
  }
  else{
    deviceShareHistory.delete(
      voterId
    );
  }

  return validHistory;
}


/* =========================================
   デバイス共有上限状態
========================================= */

function getDeviceShareLimitState(
  voterId
) {
  const id =
    safeString(voterId);

  if(!id){
    return {
      allowed:true,
      count:0,
      remaining:DEVICE_SHARE_LIMIT,
      resetAt:null,
    };
  }

  const history =
    pruneDeviceShareHistory(id);

  const count =
    history.length;

  const oldest =
    history.length > 0
      ? history[0]
      : null;

  const resetAt =
    oldest !== null
      ? oldest +
        DEVICE_SHARE_WINDOW_MS
      : null;

  return {
    allowed:
      count < DEVICE_SHARE_LIMIT,

    count,

    remaining:
      Math.max(
        0,
        DEVICE_SHARE_LIMIT - count
      ),

    resetAt,
  };
}


/* =========================================
   デバイス共有記録
========================================= */

function recordDeviceShare(
  voterId
) {
  const id =
    safeString(voterId);

  if(!id){
    return;
  }

  const history =
    pruneDeviceShareHistory(id);

  history.push(
    Date.now()
  );

  deviceShareHistory.set(
    id,
    history
  );
}


/* =========================================
   管理者トークン
========================================= */

function getAdminToken(req) {
  const authorization =
    typeof req.headers.authorization === "string"
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

  if(token){
    const session =
      adminSessions.get(token);

    if(!session){
      return false;
    }

    if(
      Date.now() -
        session.createdAt >
      ADMIN_SESSION_TTL_MS
    ){
      adminSessions.delete(
        token
      );

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
   混雑データをJSON用オブジェクトへ
========================================= */

function getCrowdDataObject() {
  const result = {};

  for(
    const [
      id,
      value
    ] of crowdData.entries()
  ){
    result[id] = value;
  }

  return result;
}


/* =========================================
   ヘルスチェック
========================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok:true,
      message:
        "Chosei Festival crowd server is running.",
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
      typeof req.body?.password === "string"
        ? req.body.password
        : "";

    if(
      !ADMIN_PASSWORD ||
      password !==
        ADMIN_PASSWORD
    ){
      return res.status(401).json({
        ok:false,
        error:
          "パスワードが正しくありません。",
      });
    }

    const token =
      crypto
        .randomBytes(32)
        .toString("hex");

    adminSessions.set(
      token,
      {
        createdAt:
          Date.now(),
      }
    );

    return res.json({
      ok:true,
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

    if(token){
      adminSessions.delete(
        token
      );
    }

    return res.json({
      ok:true,
    });
  }
);


/* =========================================
   管理者状態取得
========================================= */

app.get(
  "/api/admin/state",
  (req, res) => {

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    return res.json({
      ok:true,

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

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    sharingEnabled =
      req.body?.enabled !== false;

    return res.json({
      ok:true,

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

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    const id =
      typeof req.body?.id === "string"
        ? req.body.id.trim()
        : "";

    if(!id){
      return res.status(400).json({
        ok:false,
        error:
          "idが指定されていません。",
      });
    }

    hiddenIds.add(id);

    return res.json({
      ok:true,

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

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    const id =
      typeof req.body?.id === "string"
        ? req.body.id.trim()
        : "";

    if(!id){
      return res.status(400).json({
        ok:false,
        error:
          "idが指定されていません。",
      });
    }

    hiddenIds.delete(id);

    return res.json({
      ok:true,

      hiddenIds:
        Array.from(hiddenIds),

      updatedAt:
        new Date().toISOString(),
    });
  }
);


/* =========================================
   管理者用 全データ取得
========================================= */

app.get(
  "/api/admin/crowd",
  (req, res) => {

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    return res.json({
      ok:true,

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

    if(
      !isAdminAuthorized(req)
    ){
      return res.status(401).json({
        ok:false,
        error:
          "管理者認証に失敗しました。",
      });
    }

    crowdData.clear();

    hiddenIds.clear();


    /* -----------------------------------------
       デバイスごとの共有履歴もリセット
    ----------------------------------------- */

    deviceShareHistory.clear();


    return res.json({
      ok:true,

      message:
        "混雑状況をリセットしました。",

      crowd:{},

      hiddenIds:[],

      sharingEnabled,
    });
  }
);


/* =========================================
   混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    return res.json({
      ok:true,

      crowd:
        getCrowdDataObject(),

      hiddenIds:
        Array.from(hiddenIds),

      sharingEnabled,
    });
  }
);


/* =========================================
   デバイスごとの共有上限確認
========================================= */

app.get(
  "/api/crowd/limit",
  (req, res) => {

    const voterId =
      safeString(
        req.query.voterId
      );

    const state =
      getDeviceShareLimitState(
        voterId
      );

    return res.json({
      ok:true,

      voterId,

      limit:
        DEVICE_SHARE_LIMIT,

      windowMs:
        DEVICE_SHARE_WINDOW_MS,

      count:
        state.count,

      remaining:
        state.remaining,

      allowed:
        state.allowed,

      resetAt:
        state.resetAt,
    });
  }
);


/* =========================================
   混雑情報共有
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {

    if(!sharingEnabled){

      return res.status(403).json({
        ok:false,

        error:
          "現在、混雑情報の共有は停止されています。",
      });
    }


    const id =
      safeString(
        req.body?.id
      );

    const status =
      safeString(
        req.body?.status,
        "unknown"
      );

    const score =
      Number(
        req.body?.score
      );

    const voterId =
      safeString(
        req.body?.voterId
      );


    if(!id){

      return res.status(400).json({
        ok:false,

        error:
          "企画IDが指定されていません。",
      });
    }


    if(!voterId){

      return res.status(400).json({
        ok:false,

        error:
          "端末IDが指定されていません。",
      });
    }


    /* -----------------------------------------
       デバイスごとの共有上限
    ----------------------------------------- */

    const limitState =
      getDeviceShareLimitState(
        voterId
      );

    if(
      !limitState.allowed
    ){

      return res.status(429).json({

        ok:false,

        error:
          "この端末の共有上限に達しています。",

        reason:
          "device-share-limit",

        limit:
          DEVICE_SHARE_LIMIT,

        count:
          limitState.count,

        remaining:
          limitState.remaining,

        resetAt:
          limitState.resetAt,
      });
    }


    /* -----------------------------------------
       スコア確認
    ----------------------------------------- */

    let normalizedScore =
      Number.isFinite(score)
        ? Math.round(score)
        : null;

    if(
      normalizedScore !== null
    ){
      normalizedScore =
        Math.max(
          0,
          Math.min(
            100,
            normalizedScore
          )
        );
    }


    /* -----------------------------------------
       既存データ
    ----------------------------------------- */

    const existing =
      crowdData.get(id) ||
      null;


    const oldVoteCount =
      existing &&
      Number.isFinite(
        Number(
          existing.voteCount
        )
      )
        ? Math.max(
            0,
            Math.round(
              Number(
                existing.voteCount
              )
            )
          )
        : 0;


    const voteCount =
      oldVoteCount + 1;


    /* -----------------------------------------
       データ保存
    ----------------------------------------- */

    const data = {

      status,

      score:
        normalizedScore,

      voteCount,

      updatedAt:
        new Date().toISOString(),

    };


    crowdData.set(
      id,
      data
    );


    /* -----------------------------------------
       共有成功後に履歴へ追加
    ----------------------------------------- */

    recordDeviceShare(
      voterId
    );


    const newLimitState =
      getDeviceShareLimitState(
        voterId
      );


    return res.json({

      ok:true,

      id,

      data,

      limit:{

        count:
          newLimitState.count,

        remaining:
          newLimitState.remaining,

        allowed:
          newLimitState.allowed,

        resetAt:
          newLimitState.resetAt,

      },

    });
  }
);


/* =========================================
   404
========================================= */

app.use(
  (req, res) => {

    res.status(404).json({
      ok:false,

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

    console.error(
      error
    );

    if(res.headersSent){
      return next(error);
    }

    res.status(500).json({

      ok:false,

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
