const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

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

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "hello";

const adminSessions = new Map();

const ADMIN_SESSION_MAX_AGE_MS =
  12 * 60 * 60 * 1000;


/* =========================================
   混雑情報
========================================= */

let crowdData = {};


/*
  管理画面から非表示にしたカードID
*/
const hiddenCrowdIds = new Set();


/*
  混雑状況の共有機能
  true  = 使用可能
  false = 長高祭開始まで使用不可
*/
let crowdSharingEnabled = true;


/* =========================================
   管理者認証
========================================= */

function getAdminToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.substring(7);
}


function isAdminAuthenticated(req) {
  const token = getAdminToken(req);

  if (!token) {
    return false;
  }

  const session = adminSessions.get(token);

  if (!session) {
    return false;
  }

  /*
    セッション有効期限チェック
  */
  if (
    Date.now() - session.createdAt >
    ADMIN_SESSION_MAX_AGE_MS
  ) {
    adminSessions.delete(token);
    return false;
  }

  return true;
}


function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({
      success: false,
      message: "管理者認証が必要です。",
    });
  }

  next();
}


/* =========================================
   混雑状況計算
========================================= */

function calculateCrowdStatus(data) {
  if (!data) {
    return {
      status: "unknown",
      label: "情報なし",
      score: 0,
      votes: 0,
    };
  }

  const score =
    typeof data.score === "number"
      ? data.score
      : 0;

  const votes =
    typeof data.votes === "number"
      ? data.votes
      : 0;

  let status = "unknown";
  let label = "情報なし";

  if (votes > 0) {
    if (score >= 4) {
      status = "very-crowded";
      label = "かなり混雑";
    } else if (score >= 3) {
      status = "crowded";
      label = "混雑";
    } else if (score >= 2) {
      status = "normal";
      label = "やや混雑";
    } else {
      status = "empty";
      label = "空いています";
    }
  }

  return {
    status,
    label,
    score,
    votes,
  };
}


/* =========================================
   古い混雑情報の削除
========================================= */

function cleanOldData() {
  const now = Date.now();

  const MAX_AGE =
    1000 * 60 * 60 * 24;

  for (const id of Object.keys(crowdData)) {
    const item = crowdData[id];

    if (!item || !item.updatedAt) {
      continue;
    }

    const updatedTime =
      new Date(item.updatedAt).getTime();

    if (
      !Number.isNaN(updatedTime) &&
      now - updatedTime > MAX_AGE
    ) {
      delete crowdData[id];
    }
  }
}


/* =========================================
   SSE
========================================= */

const crowdClients = new Set();


function broadcastCrowdUpdate() {
  const payload = JSON.stringify({
    type: "crowd-update",
    data: crowdData,
    sharingEnabled: crowdSharingEnabled,
    hiddenIds: Array.from(hiddenCrowdIds),
  });

  for (const client of crowdClients) {
    try {
      client.write(
        `data: ${payload}\n\n`
      );
    } catch (error) {
      crowdClients.delete(client);
    }
  }
}


/* =========================================
   管理者ログイン
========================================= */

app.post(
  "/api/admin/login",
  (req, res) => {
    const password =
      req.body?.password || "";

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        message: "パスワードが違います。",
      });
    }

    const token =
      crypto.randomBytes(32).toString("hex");

    adminSessions.set(token, {
      createdAt: Date.now(),
    });

    return res.json({
      success: true,
      token,
    });
  }
);


/* =========================================
   管理者状態取得
========================================= */

app.get(
  "/api/admin/state",
  requireAdmin,
  (req, res) => {
    cleanOldData();

    const visibleCrowdData = {};

    for (
      const [id, data]
      of Object.entries(crowdData)
    ) {
      if (
        hiddenCrowdIds.has(id)
      ) {
        continue;
      }

      visibleCrowdData[id] = {
        ...data,
        ...calculateCrowdStatus(data),
      };
    }

    res.json({
      success: true,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(hiddenCrowdIds),

      crowdData:
        visibleCrowdData,

      allCrowdData:
        Object.fromEntries(
          Object.entries(crowdData).map(
            ([id, data]) => [
              id,
              {
                ...data,
                ...calculateCrowdStatus(data),
              },
            ]
          )
        ),
    });
  }
);


/* =========================================
   公開用設定取得
========================================= */

app.get(
  "/api/crowd/settings",
  (req, res) => {
    res.json({
      success: true,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(hiddenCrowdIds),
    });
  }
);


/* =========================================
   管理画面
   混雑情報共有 ON / OFF
========================================= */

app.post(
  "/api/admin/sharing",
  requireAdmin,
  (req, res) => {
    const enabled =
      req.body?.enabled;

    if (
      typeof enabled !== "boolean"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "enabled は true または false にしてください。",
      });
    }

    crowdSharingEnabled =
      enabled;

    broadcastCrowdUpdate();

    res.json({
      success: true,

      sharingEnabled:
        crowdSharingEnabled,
    });
  }
);


/* =========================================
   管理画面
   カードを非表示にする
========================================= */

app.post(
  "/api/admin/card/hide",
  requireAdmin,
  (req, res) => {
    const id =
      String(req.body?.id || "").trim();

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "IDが指定されていません。",
      });
    }

    hiddenCrowdIds.add(id);

    broadcastCrowdUpdate();

    res.json({
      success: true,

      hiddenIds:
        Array.from(hiddenCrowdIds),
    });
  }
);


/* =========================================
   管理画面
   非表示カードを復元
========================================= */

app.post(
  "/api/admin/card/restore",
  requireAdmin,
  (req, res) => {
    const id =
      String(req.body?.id || "").trim();

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "IDが指定されていません。",
      });
    }

    hiddenCrowdIds.delete(id);

    broadcastCrowdUpdate();

    res.json({
      success: true,

      hiddenIds:
        Array.from(hiddenCrowdIds),
    });
  }
);


/* =========================================
   混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {
    cleanOldData();

    const result = {};

    for (
      const [id, data]
      of Object.entries(crowdData)
    ) {
      /*
        管理画面で削除したカードは
        一般公開側には表示しない
      */
      if (
        hiddenCrowdIds.has(id)
      ) {
        continue;
      }

      result[id] = {
        ...data,
        ...calculateCrowdStatus(data),
      };
    }

    res.json(result);
  }
);


/* =========================================
   混雑情報登録
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {
    /*
      管理画面で共有をOFFにしている場合
      新しい混雑情報を受け付けない
    */
    if (!crowdSharingEnabled) {
      return res.status(403).json({
        success: false,

        message:
          "現在、混雑状況の共有は停止しています。",
      });
    }

    const {
      id,
      score,
      votes,
    } = req.body || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        message:
          "イベントIDが指定されていません。",
      });
    }

    const normalizedId =
      String(id).trim();

    const numericScore =
      Number(score);

    const numericVotes =
      Number(votes);

    if (
      !Number.isFinite(
        numericScore
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "score が不正です。",
      });
    }

    if (
      !Number.isFinite(
        numericVotes
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "votes が不正です。",
      });
    }

    /*
      データ保存
    */
    crowdData[normalizedId] = {
      score:
        numericScore,

      votes:
        numericVotes,

      updatedAt:
        new Date().toISOString(),
    };

    const result = {
      id: normalizedId,

      ...crowdData[
        normalizedId
      ],

      ...calculateCrowdStatus(
        crowdData[
          normalizedId
        ]
      ),
    };

    broadcastCrowdUpdate();

    res.json({
      success: true,
      data: result,
    });
  }
);


/* =========================================
   特定IDの混雑情報取得
========================================= */

app.get(
  "/api/crowd/:id",
  (req, res) => {
    const id =
      String(
        req.params.id || ""
      ).trim();

    if (
      hiddenCrowdIds.has(id)
    ) {
      return res.status(404).json({
        success: false,
        message:
          "混雑情報が見つかりません。",
      });
    }

    const data =
      crowdData[id];

    if (!data) {
      return res.status(404).json({
        success: false,
        message:
          "混雑情報が見つかりません。",
      });
    }

    res.json({
      id,

      ...data,

      ...calculateCrowdStatus(
        data
      ),
    });
  }
);


/* =========================================
   混雑情報削除
========================================= */

app.delete(
  "/api/crowd/:id",
  (req, res) => {
    const id =
      String(
        req.params.id || ""
      ).trim();

    if (!crowdData[id]) {
      return res.status(404).json({
        success: false,
        message:
          "混雑情報が見つかりません。",
      });
    }

    delete crowdData[id];

    broadcastCrowdUpdate();

    res.json({
      success: true,
    });
  }
);


/* =========================================
   SSE
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
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    /*
      接続直後に現在の状態を送信
    */
    const initialPayload =
      JSON.stringify({
        type: "crowd-update",

        data:
          crowdData,

        sharingEnabled:
          crowdSharingEnabled,

        hiddenIds:
          Array.from(
            hiddenCrowdIds
          ),
      });

    res.write(
      `data: ${initialPayload}\n\n`
    );

    crowdClients.add(res);

    /*
      接続確認用
    */
    const heartbeat =
      setInterval(() => {
        try {
          res.write(
            `: heartbeat\n\n`
          );
        } catch (error) {
          clearInterval(
            heartbeat
          );

          crowdClients.delete(
            res
          );
        }
      }, 30000);

    /*
      接続終了時
    */
    req.on(
      "close",
      () => {
        clearInterval(
          heartbeat
        );

        crowdClients.delete(
          res
        );
      }
    );
  }
);


/* =========================================
   定期的な古いデータ削除
========================================= */

setInterval(
  () => {
    cleanOldData();
  },
  1000 * 60 * 30
);


/* =========================================
   エラーハンドリング
========================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Server Error:",
      err
    );

    res.status(500).json({
      success: false,
      message:
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
