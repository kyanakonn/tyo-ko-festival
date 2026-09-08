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

/*
  管理画面のパスワード

  Renderの環境変数
  ADMIN_PASSWORD
  が設定されている場合はそちらを優先します。

  未設定の場合は hello
*/
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "hello";


/*
  管理者ログインセッション
*/
const adminSessions = new Map();


/*
  管理者ログインの有効時間
  12h
*/
const ADMIN_SESSION_MAX_AGE_MS =
  12 * 60 * 60 * 1000;


/* =========================================
   混雑情報
========================================= */

/*
  現在の混雑情報

  例：

  {
    "event-id": {
      status: "crowded",
      score: 75,
      confidence: 80,
      voteCount: 10,
      effectiveVotes: 10,
      updatedAt: "2026-09-12T..."
    }
  }
*/
let crowdData = {};


/*
  管理画面から非表示にしたカードのID
*/
const hiddenCrowdIds = new Set();


/*
  混雑情報共有機能

  false = 初期状態
  true  = 管理画面からONにした状態

  ★ 初期状態はOFF
*/
let crowdSharingEnabled = false;


/* =========================================
   管理者認証
========================================= */

function getAdminToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }

  return authorization.substring(7);
}


function isAdminAuthenticated(req) {
  const token =
    getAdminToken(req);

  if (!token) {
    return false;
  }

  const session =
    adminSessions.get(token);

  if (!session) {
    return false;
  }

  /*
    セッション有効期限
  */
  if (
    Date.now() -
      session.createdAt >
    ADMIN_SESSION_MAX_AGE_MS
  ) {
    adminSessions.delete(token);

    return false;
  }

  return true;
}


function requireAdmin(
  req,
  res,
  next
) {
  if (
    !isAdminAuthenticated(req)
  ) {
    return res.status(401).json({
      success: false,
      message:
        "管理者認証が必要です。",
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
      score: null,
      confidence: null,
      voteCount: 0,
      effectiveVotes: 0,
    };
  }


  /*
    statusがすでに保存されている場合
    それを優先して使用する
  */
  const savedStatus =
    typeof data.status === "string"
      ? data.status
      : "";


  const scoreNumber =
    Number(data.score);


  const confidenceNumber =
    Number(data.confidence);


  const voteCountNumber =
    Number(data.voteCount);


  const effectiveVotesNumber =
    Number(data.effectiveVotes);


  const score =
    Number.isFinite(scoreNumber)
      ? scoreNumber
      : null;


  const confidence =
    Number.isFinite(
      confidenceNumber
    )
      ? confidenceNumber
      : null;


  const voteCount =
    Number.isFinite(
      voteCountNumber
    )
      ? voteCountNumber
      : 0;


  const effectiveVotes =
    Number.isFinite(
      effectiveVotesNumber
    )
      ? effectiveVotesNumber
      : 0;


  /*
    statusが保存されている場合
  */
  if (savedStatus) {

    let label =
      "情報なし";


    switch (
      savedStatus
    ) {

      case "empty":
        label =
          "空いています";
        break;

      case "normal":
        label =
          "やや混雑";
        break;

      case "crowded":
        label =
          "混雑";
        break;

      case "very-crowded":
        label =
          "かなり混雑";
        break;

      case "unknown":
      default:
        label =
          "情報なし";
        break;
    }


    return {
      status:
        savedStatus,

      label,

      score,

      confidence,

      voteCount,

      effectiveVotes,
    };
  }


  /*
    statusがない古いデータなどの場合
    scoreから自動判定
  */
  if (
    score === null
  ) {
    return {
      status: "unknown",
      label: "情報なし",
      score: null,
      confidence,
      voteCount,
      effectiveVotes,
    };
  }


  let status =
    "unknown";


  let label =
    "情報なし";


  if (score >= 80) {

    status =
      "very-crowded";

    label =
      "かなり混雑";

  } else if (
    score >= 60
  ) {

    status =
      "crowded";

    label =
      "混雑";

  } else if (
    score >= 30
  ) {

    status =
      "normal";

    label =
      "やや混雑";

  } else {

    status =
      "empty";

    label =
      "空いています";
  }


  return {
    status,

    label,

    score,

    confidence,

    voteCount,

    effectiveVotes,
  };
}


/* =========================================
   古いデータ削除
========================================= */

function cleanOldData() {

  const now =
    Date.now();


  /*
    24時間以上前のデータを削除
  */
  const MAX_AGE =
    1000 *
    60 *
    60 *
    24;


  for (
    const id of Object.keys(
      crowdData
    )
  ) {

    const item =
      crowdData[id];


    if (
      !item ||
      !item.updatedAt
    ) {
      continue;
    }


    const updatedTime =
      new Date(
        item.updatedAt
      ).getTime();


    if (
      !Number.isNaN(
        updatedTime
      ) &&
      now - updatedTime >
        MAX_AGE
    ) {

      delete crowdData[id];
    }
  }
}


/* =========================================
   SSE
========================================= */

const crowdClients =
  new Set();


function broadcastCrowdUpdate() {

  const payload =
    JSON.stringify({

      type:
        "crowd-update",

      data:
        crowdData,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),
    });


  for (
    const client of crowdClients
  ) {

    try {

      client.write(
        `data: ${payload}\n\n`
      );

    } catch (
      error
    ) {

      crowdClients.delete(
        client
      );
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


    if (
      password !==
      ADMIN_PASSWORD
    ) {

      return res.status(401).json({

        success: false,

        message:
          "パスワードが違います。",
      });
    }


    /*
      ランダムなセッショントークン
    */
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


    /*
      一般公開されている
      混雑情報
    */
    const visibleCrowdData =
      {};


    /*
      すべての混雑情報
      管理画面用
    */
    const allCrowdData =
      {};


    for (
      const [
        id,
        data
      ]
      of Object.entries(
        crowdData
      )
    ) {

      const formatted = {

        ...data,

        ...calculateCrowdStatus(
          data
        ),
      };


      /*
        管理画面には
        非表示カードも表示
      */
      allCrowdData[id] =
        formatted;


      /*
        一般公開側に表示するもの
      */
      if (
        !hiddenCrowdIds.has(
          id
        )
      ) {

        visibleCrowdData[id] =
          formatted;
      }
    }


    res.json({

      success: true,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),

      crowdData:
        visibleCrowdData,

      allCrowdData,
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
        Array.from(
          hiddenCrowdIds
        ),
    });
  }
);


/* =========================================
   共有機能 ON / OFF
========================================= */

app.post(
  "/api/admin/sharing",
  requireAdmin,
  (req, res) => {

    const enabled =
      req.body?.enabled;


    if (
      typeof enabled !==
      "boolean"
    ) {

      return res.status(400).json({

        success: false,

        message:
          "enabled は true または false にしてください。",
      });
    }


    crowdSharingEnabled =
      enabled;


    /*
      一般公開ページへ
      即時反映
    */
    broadcastCrowdUpdate();


    res.json({

      success: true,

      sharingEnabled:
        crowdSharingEnabled,
    });
  }
);


/* =========================================
   カード非表示
========================================= */

app.post(
  "/api/admin/card/hide",
  requireAdmin,
  (req, res) => {

    const id =
      String(
        req.body?.id || ""
      ).trim();


    if (!id) {

      return res.status(400).json({

        success: false,

        message:
          "IDが指定されていません。",
      });
    }


    /*
      非表示リストへ追加
    */
    hiddenCrowdIds.add(
      id
    );


    /*
      一般公開ページへ
      即時反映
    */
    broadcastCrowdUpdate();


    res.json({

      success: true,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),
    });
  }
);


/* =========================================
   カード復元
========================================= */

app.post(
  "/api/admin/card/restore",
  requireAdmin,
  (req, res) => {

    const id =
      String(
        req.body?.id || ""
      ).trim();


    if (!id) {

      return res.status(400).json({

        success: false,

        message:
          "IDが指定されていません。",
      });
    }


    /*
      非表示リストから削除
    */
    hiddenCrowdIds.delete(
      id
    );


    /*
      一般公開ページへ
      即時反映
    */
    broadcastCrowdUpdate();


    res.json({

      success: true,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),
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


    const result =
      {};


    for (
      const [
        id,
        data
      ]
      of Object.entries(
        crowdData
      )
    ) {

      /*
        管理画面で非表示にしたカードは
        一般公開側には返さない
      */
      if (
        hiddenCrowdIds.has(
          id
        )
      ) {
        continue;
      }


      result[id] = {

        ...data,

        ...calculateCrowdStatus(
          data
        ),
      };
    }


    res.json(
      result
    );
  }
);


/* =========================================
   混雑情報共有
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {

    /*
      ★ 共有機能OFFの場合
      サーバー側で完全に拒否
    */
    if (
      crowdSharingEnabled !==
      true
    ) {

      return res.status(403).json({

        success: false,

        error:
          "現在、混雑状況の共有は停止しています。",
      });
    }


    const {
      id,
      status,
      voterId,
      score,
      confidence,
      voteCount,
      effectiveVotes,
    } =
      req.body || {};


    /*
      ID確認
    */
    if (!id) {

      return res.status(400).json({

        success: false,

        error:
          "企画IDが指定されていません。",
      });
    }


    const normalizedId =
      String(id).trim();


    /*
      status確認
    */
    if (
      typeof status !==
      "string" ||
      !status.trim()
    ) {

      return res.status(400).json({

        success: false,

        error:
          "混雑状況が指定されていません。",
      });
    }


    /*
      送信された情報を
      数値化
    */
    let numericScore =
      Number(score);


    let numericConfidence =
      Number(confidence);


    let numericVoteCount =
      Number(voteCount);


    let numericEffectiveVotes =
      Number(
        effectiveVotes
      );


    /*
      scoreが送られていない場合
      statusから計算
    */
    if (
      !Number.isFinite(
        numericScore
      )
    ) {

      switch (
        status
      ) {

        case "empty":
          numericScore =
            10;
          break;

        case "normal":
          numericScore =
            45;
          break;

        case "crowded":
          numericScore =
            70;
          break;

        case "very-crowded":
          numericScore =
            90;
          break;

        default:
          numericScore =
            0;
          break;
      }
    }


    /*
      範囲を0～100に制限
    */
    numericScore =
      Math.max(
        0,
        Math.min(
          100,
          numericScore
        )
      );


    /*
      confidenceがない場合
      ひとまず既存値を利用
      なければ0
    */
    if (
      !Number.isFinite(
        numericConfidence
      )
    ) {

      const existing =
        crowdData[
          normalizedId
        ];


      numericConfidence =
        existing &&
        Number.isFinite(
          Number(
            existing.confidence
          )
        )
          ? Number(
              existing.confidence
            )
          : 0;
    }


    /*
      投票数
    */
    if (
      !Number.isFinite(
        numericVoteCount
      )
    ) {

      const existing =
        crowdData[
          normalizedId
        ];


      numericVoteCount =
        existing &&
        Number.isFinite(
          Number(
            existing.voteCount
          )
        )
          ? Number(
              existing.voteCount
            ) + 1
          : 1;
    }


    /*
      有効投票数
    */
    if (
      !Number.isFinite(
        numericEffectiveVotes
      )
    ) {

      const existing =
        crowdData[
          normalizedId
        ];


      numericEffectiveVotes =
        existing &&
        Number.isFinite(
          Number(
            existing.effectiveVotes
          )
        )
          ? Number(
              existing.effectiveVotes
            ) + 1
          : 1;
    }


    /*
      voterIdは
      現在のデータ構造では保存
    */
    const normalizedVoterId =
      voterId
        ? String(
            voterId
          )
        : null;


    /*
      混雑情報保存
    */
    crowdData[
      normalizedId
    ] = {

      status:
        status.trim(),

      score:
        numericScore,

      confidence:
        Math.max(
          0,
          Math.min(
            100,
            numericConfidence
          )
        ),

      voteCount:
        Math.max(
          0,
          Math.round(
            numericVoteCount
          )
        ),

      effectiveVotes:
        Math.max(
          0,
          Math.round(
            numericEffectiveVotes
          )
        ),

      voterId:
        normalizedVoterId,

      updatedAt:
        new Date().toISOString(),
    };


    /*
      保存後のデータ
    */
    const result = {

      id:
        normalizedId,

      ...crowdData[
        normalizedId
      ],

      ...calculateCrowdStatus(
        crowdData[
          normalizedId
        ]
      ),
    };


    /*
      SSEでリアルタイム通知
    */
    broadcastCrowdUpdate();


    /*
      crowd.htmlが期待している
      プロパティを直接返す
    */
    res.json({

      success: true,

      id:
        normalizedId,

      status:
        result.status,

      crowdStatus:
        result.status,

      crowd_status:
        result.status,

      score:
        result.score,

      confidence:
        result.confidence,

      voteCount:
        result.voteCount,

      effectiveVotes:
        result.effectiveVotes,

      updatedAt:
        result.updatedAt,

      data:
        result,
    });
  }
);


/* =========================================
   特定IDの混雑情報
========================================= */

app.get(
  "/api/crowd/:id",
  (req, res) => {

    const id =
      String(
        req.params.id || ""
      ).trim();


    /*
      非表示カードは
      一般公開側から取得不可
    */
    if (
      hiddenCrowdIds.has(
        id
      )
    ) {

      return res.status(404).json({

        success: false,

        error:
          "混雑情報が見つかりません。",
      });
    }


    const data =
      crowdData[id];


    if (!data) {

      return res.status(404).json({

        success: false,

        error:
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


    if (
      !crowdData[id]
    ) {

      return res.status(404).json({

        success: false,

        error:
          "混雑情報が見つかりません。",
      });
    }


    delete crowdData[id];


    /*
      非表示設定も削除
    */
    hiddenCrowdIds.delete(
      id
    );


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

        type:
          "crowd-update",

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


    /*
      接続中クライアントとして登録
    */
    crowdClients.add(
      res
    );


    /*
      ハートビート
    */
    const heartbeat =
      setInterval(
        () => {

          try {

            res.write(
              `: heartbeat\n\n`
            );

          } catch (
            error
          ) {

            clearInterval(
              heartbeat
            );

            crowdClients.delete(
              res
            );
          }

        },
        30000
      );


    /*
      接続終了
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
  1000 *
  60 *
  30
);


/* =========================================
   管理セッションの定期掃除
========================================= */

setInterval(
  () => {

    const now =
      Date.now();


    for (
      const [
        token,
        session
      ]
      of adminSessions
    ) {

      if (
        !session ||
        now -
          session.createdAt >
          ADMIN_SESSION_MAX_AGE_MS
      ) {

        adminSessions.delete(
          token
        );
      }
    }

  },
  1000 *
  60 *
  60
);


/* =========================================
   エラーハンドリング
========================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "Server Error:",
      err
    );


    res.status(500).json({

      success: false,

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
