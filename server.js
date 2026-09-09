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
  が設定されている場合はそちらを優先

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
  全体共有制限

  10分間に最大5回まで。
  サーバー側で管理するため、利用者ごとではなく
  サイト全体で共有回数を制限します。
*/
const GLOBAL_SHARE_LIMIT = 5;
const GLOBAL_SHARE_WINDOW_MS = 10 * 60 * 1000;


/*
  同じ人が同じカードへ再共有できるまでの間隔
  サーバー側で必ず判定します。
*/
const SAME_CARD_SHARE_COOLDOWN_MS =
  5 * 60 * 1000;


/*
  混雑情報の時間減衰

  30分で影響力が半分になります。
  古い投票ほど score / confidence への影響が
  少なくなり、最終的には情報なしへ近づきます。
*/
const CROWD_DECAY_HALF_LIFE_MS =
  30 * 60 * 1000;


/*
  全体共有履歴
  各要素は共有された時刻(ms)だけを保持します。
*/
const globalShareHistory = [];


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

function calculateCrowdStatus(
  data,
  now = Date.now()
) {

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
    新方式では、各共有を votes 配列に保存し、
    共有からの経過時間に応じて重みを指数的に減衰させます。

    半減期30分：
      0分   → 100%
      30分  → 50%
      60分  → 25%
      90分  → 12.5%
  */
  let votes =
    Array.isArray(data.votes)
      ? data.votes
      : [];


  /*
    旧方式で保存されたデータにも時間減衰を適用するため、
    updatedAt と status から仮想的な1票へ変換します。
  */
  if (
    votes.length === 0 &&
    data.updatedAt
  ) {

    const legacyTimestamp =
      new Date(
        data.updatedAt
      ).getTime();

    if (
      Number.isFinite(
        legacyTimestamp
      )
    ) {
      votes = [{
        status:
          typeof data.status === "string"
            ? data.status
            : "unknown",
        timestamp:
          legacyTimestamp,
      }];
    }
  }


  if (votes.length > 0) {

    let weightedScoreSum = 0;
    let effectiveVotes = 0;


    for (const vote of votes) {

      if (
        !vote ||
        !vote.timestamp
      ) {
        continue;
      }

      const timestamp =
        Number(
          vote.timestamp
        );

      if (
        !Number.isFinite(
          timestamp
        )
      ) {
        continue;
      }

      const age =
        Math.max(
          0,
          now - timestamp
        );

      const weight =
        Math.pow(
          0.5,
          age /
            CROWD_DECAY_HALF_LIFE_MS
        );

      const voteScore =
        getScoreFromStatus(
          vote.status
        );

      if (
        voteScore === null
      ) {
        continue;
      }

      effectiveVotes +=
        weight;

      weightedScoreSum +=
        voteScore *
        weight;
    }


    const voteCount =
      votes.length;


    if (
      effectiveVotes <= 0.01
    ) {
      return {
        status: "unknown",
        label: "情報なし",
        score: null,
        confidence: 0,
        voteCount,
        effectiveVotes: 0,
      };
    }


    const weightedAverage =
      weightedScoreSum /
      effectiveVotes;


    /*
      effectiveVotes が1未満になるほど
      混雑度を「50 = 中立」へ戻します。
      これにより score 自体も時間経過で影響を失います。
    */
    const scoreInfluence =
      Math.min(
        1,
        effectiveVotes
      );

    const score =
      50 +
      (
        weightedAverage - 50
      ) *
        scoreInfluence;


    /*
      信頼度も有効投票数から算出し、
      古い投票が減衰すると自動的に下がります。
    */
    const confidence =
      100 *
      (
        1 -
        Math.exp(
          -effectiveVotes / 3
        )
      );


    let status = "unknown";
    let label = "情報なし";


    if (
      score >= 80
    ) {
      status = "very-crowded";
      label = "かなり混雑";
    } else if (
      score >= 60
    ) {
      status = "crowded";
      label = "混雑";
    } else if (
      score >= 30
    ) {
      status = "normal";
      label = "やや混雑";
    } else {
      status = "empty";
      label = "空いています";
    }


    /*
      情報の影響が十分小さくなったら、
      「情報なし」に戻します。
    */
    if (
      effectiveVotes < 0.10
    ) {
      status = "unknown";
      label = "情報なし";
    }


    return {
      status,
      label,
      score:
        Math.max(
          0,
          Math.min(
            100,
            Math.round(score)
          )
        ),
      confidence:
        Math.max(
          0,
          Math.min(
            100,
            Math.round(confidence)
          )
        ),
      voteCount,
      effectiveVotes:
        Number(
          effectiveVotes.toFixed(3)
        ),
    };
  }


  /*
    旧データとの互換性。
    votes が存在しない既存データは、
    そのデータを即座に壊さず従来値を表示します。
    新しく共有された時点で新方式へ移行します。
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
    Number.isFinite(
      scoreNumber
    )
      ? Math.max(
          0,
          Math.min(
            100,
            scoreNumber
          )
        )
      : null;

  const confidence =
    Number.isFinite(
      confidenceNumber
    )
      ? Math.max(
          0,
          Math.min(
            100,
            confidenceNumber
          )
        )
      : null;

  const voteCount =
    Number.isFinite(
      voteCountNumber
    )
      ? Math.max(
          0,
          voteCountNumber
        )
      : 0;

  const effectiveVotes =
    Number.isFinite(
      effectiveVotesNumber
    )
      ? Math.max(
          0,
          effectiveVotesNumber
        )
      : voteCount;

  if (!savedStatus) {
    return {
      status: "unknown",
      label: "情報なし",
      score,
      confidence,
      voteCount,
      effectiveVotes,
    };
  }

  const labelMap = {
    empty: "空いています",
    normal: "やや混雑",
    crowded: "混雑",
    "very-crowded": "かなり混雑",
    unknown: "情報なし",
  };

  return {
    status: savedStatus,
    label:
      labelMap[savedStatus] ||
      "情報なし",
    score,
    confidence,
    voteCount,
    effectiveVotes,
  };
}


function getScoreFromStatus(
  status
) {

  switch (status) {
    case "empty":
      return 10;

    case "normal":
      return 45;

    case "crowded":
      return 70;

    case "very-crowded":
      return 90;

    default:
      return null;
  }
}


function pruneGlobalShareHistory(
  now = Date.now()
) {

  const cutoff =
    now -
    GLOBAL_SHARE_WINDOW_MS;

  while (
    globalShareHistory.length > 0 &&
    globalShareHistory[0] <= cutoff
  ) {
    globalShareHistory.shift();
  }
}


function getGlobalShareLimitState(
  now = Date.now()
) {

  pruneGlobalShareHistory(
    now
  );

  const count =
    globalShareHistory.length;

  if (
    count <
    GLOBAL_SHARE_LIMIT
  ) {
    return {
      limit:
        GLOBAL_SHARE_LIMIT,

      used:
        count,

      remaining:
        GLOBAL_SHARE_LIMIT -
        count,

      retryAfterMs:
        0,
    };
  }

  const oldest =
    globalShareHistory[0];

  return {
    limit:
      GLOBAL_SHARE_LIMIT,

    used:
      count,

    remaining:
      0,

    retryAfterMs:
      Math.max(
        0,
        oldest +
          GLOBAL_SHARE_WINDOW_MS -
          now
      ),
  };
}


function recordGlobalShare(
  now = Date.now()
) {

  pruneGlobalShareHistory(
    now
  );

  globalShareHistory.push(
    now
  );
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
      now -
        updatedTime >
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
      crypto.randomBytes(32)
        .toString("hex");


    adminSessions.set(
      token,
      {
        createdAt:
          Date.now(),
      }
    );


    res.json({

      success: true,

      token,
    });
  }
);


/* =========================================
   管理者ログアウト
========================================= */

app.post(
  "/api/admin/logout",
  requireAdmin,
  (req, res) => {

    const token =
      getAdminToken(req);

    if (token) {
      adminSessions.delete(
        token
      );
    }

    res.json({
      success: true,
    });
  }
);


/* =========================================
   管理者認証確認
========================================= */

app.get(
  "/api/admin/check",
  (req, res) => {

    res.json({
      authenticated:
        isAdminAuthenticated(
          req
        ),
    });
  }
);


/* =========================================
   管理者用 混雑情報
========================================= */

app.get(
  "/api/admin/crowd",
  requireAdmin,
  (req, res) => {

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

      result[id] = {

        ...data,

        ...calculateCrowdStatus(
          data
        ),
      };
    }


    res.json({
      data:
        result,

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
   混雑共有機能 ON / OFF
========================================= */

app.post(
  "/api/admin/crowd/toggle",
  requireAdmin,
  (req, res) => {

    crowdSharingEnabled =
      req.body?.enabled === true;


    broadcastCrowdUpdate();


    res.json({

      success: true,

      sharingEnabled:
        crowdSharingEnabled,
    });
  }
);


/* =========================================
   混雑状況リセット
========================================= */

app.post(
  "/api/admin/crowd/reset",
  requireAdmin,
  (req, res) => {

    /*
      混雑情報を完全にリセット
    */
    crowdData = {};


    /*
      全体共有制限もリセット
    */
    globalShareHistory.length = 0;


    /*
      非表示設定はそのまま維持
    */
    broadcastCrowdUpdate();


    res.json({

      success: true,

      message:
        "混雑状況をリセットしました。",
    });
  }
);


/* =========================================
   非表示カード設定
========================================= */

app.post(
  "/api/admin/crowd/hide",
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
          "企画IDが指定されていません。",
      });
    }


    hiddenCrowdIds.add(
      id
    );


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
   非表示カード解除
========================================= */

app.post(
  "/api/admin/crowd/unhide",
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
          "企画IDが指定されていません。",
      });
    }


    hiddenCrowdIds.delete(
      id
    );


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
   全体共有制限状況
========================================= */

app.get(
  "/api/crowd/limit",
  (req, res) => {

    const state =
      getGlobalShareLimitState();


    res.setHeader(
      "X-Crowd-Share-Limit",
      String(state.limit)
    );

    res.setHeader(
      "X-Crowd-Share-Remaining",
      String(state.remaining)
    );

    res.setHeader(
      "X-Crowd-Share-Retry-After-Ms",
      String(state.retryAfterMs)
    );


    res.json(
      state
    );
  }
);


/* =========================================
   混雑情報一覧
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    const limitState =
      getGlobalShareLimitState();


    res.setHeader(
      "X-Crowd-Share-Limit",
      String(
        limitState.limit
      )
    );

    res.setHeader(
      "X-Crowd-Share-Remaining",
      String(
        limitState.remaining
      )
    );

    res.setHeader(
      "X-Crowd-Share-Retry-After-Ms",
      String(
        limitState.retryAfterMs
      )
    );


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
      共有機能OFFの場合、サーバー側で完全に拒否
    */
    if (
      crowdSharingEnabled !== true
    ) {
      return res.status(403).json({

        success: false,

        error:
          "現在、混雑状況の共有は停止しています。",
      });
    }


    /*
      共有回数の判定に使う現在時刻
    */
    const now =
      Date.now();


    const {
      id,
      status,
      voterId,
    } = req.body || {};


    if (!id) {
      return res.status(400).json({

        success: false,

        error:
          "企画IDが指定されていません。",
      });
    }


    const normalizedId =
      String(
        id
      ).trim();


    if (
      typeof status !== "string" ||
      !status.trim()
    ) {
      return res.status(400).json({

        success: false,

        error:
          "混雑状況が指定されていません。",
      });
    }


    const normalizedStatus =
      status.trim();


    if (
      ![
        "empty",
        "normal",
        "crowded",
        "very-crowded",
      ].includes(
        normalizedStatus
      )
    ) {
      return res.status(400).json({

        success: false,

        error:
          "無効な混雑状況です。",
      });
    }


    const normalizedVoterId =
      voterId
        ? String(
            voterId
          ).slice(
            0,
            200
          )
        : null;


    const existing =
      crowdData[
        normalizedId
      ];


    /*
      同じ人が同じカードを再共有する場合、
      最後に共有してから5分間は再共有できません。

      この判定はサーバー側で行うため、
      ブラウザ側の制限を回避しても投稿できません。
    */
    if (
      normalizedVoterId &&
      existing &&
      Array.isArray(
        existing.votes
      )
    ) {

      const previousVote =
        existing.votes.find(
          vote =>
            vote &&
            String(
              vote.voterId || ""
            ) ===
              normalizedVoterId
        );


      if (
        previousVote
      ) {

        const previousTimestamp =
          Number(
            previousVote.timestamp
          );


        if (
          Number.isFinite(
            previousTimestamp
          )
        ) {

          const elapsed =
            now -
            previousTimestamp;


          if (
            elapsed <
            SAME_CARD_SHARE_COOLDOWN_MS
          ) {

            const retryAfterMs =
              Math.max(
                0,
                SAME_CARD_SHARE_COOLDOWN_MS -
                  elapsed
              );


            const retrySeconds =
              Math.ceil(
                retryAfterMs /
                  1000
              );


            return res.status(429).json({

              success: false,

              error:
                "このカードは、前回の共有から5分間は再共有できません。あと " +
                retrySeconds +
                " 秒後にもう一度お試しください。",

              reason:
                "same-card-cooldown",

              id:
                normalizedId,

              cooldownMs:
                SAME_CARD_SHARE_COOLDOWN_MS,

              retryAfterMs,

              nextShareAllowedAt:
                previousTimestamp +
                SAME_CARD_SHARE_COOLDOWN_MS,
            });
          }
        }
      }
    }


    /*
      サイト全体の共有上限を確認。

      同じカードの5分制限を通過した後に確認するため、
      同じカードの再共有拒否では
      全体の共有回数を消費しません。
    */
    const limitState =
      getGlobalShareLimitState(
        now
      );


    if (
      limitState.remaining <= 0
    ) {

      const retrySeconds =
        Math.ceil(
          limitState.retryAfterMs /
            1000
        );


      return res.status(429).json({

        success: false,

        error:
          "現在、全体の共有上限に達しています。約 " +
          retrySeconds +
          " 秒後にもう一度お試しください。",

        reason:
          "global-share-limit",

        limit:
          limitState.limit,

        used:
          limitState.used,

        remaining:
          0,

        retryAfterMs:
          limitState.retryAfterMs,
      });
    }


    /*
      カードデータが存在しない場合は新規作成
    */
    if (
      !existing ||
      typeof existing !== "object"
    ) {

      crowdData[
        normalizedId
      ] = {

        votes: [],

        updatedAt:
          new Date(
            now
          ).toISOString(),
      };

    } else if (
      !Array.isArray(
        existing.votes
      )
    ) {

      /*
        旧方式の集計データが残っている場合は、
        既存集計をそのまま新方式へ混ぜるのではなく、
        新方式の履歴をここから開始します。
      */
      existing.votes = [];
    }


    /*
      同じ人・同じカードの古い共有は残さず、
      新しく共有された方だけを結果に使用します。

      つまり、

      1回目：
        Aさん → normal

      5分後以降：
        Aさん → crowded

      の場合、

        normal
        crowded

      の2票として数えるのではなく、

        crowded

      の1票だけを使用します。
    */
    if (
      normalizedVoterId &&
      Array.isArray(
        crowdData[
          normalizedId
        ].votes
      )
    ) {

      crowdData[
        normalizedId
      ].votes =
        crowdData[
          normalizedId
        ].votes.filter(
          vote =>
            !vote ||
            String(
              vote.voterId || ""
            ) !==
              normalizedVoterId
        );
    }


    /*
      新しい共有を追加
    */
    crowdData[
      normalizedId
    ].votes.push({

      status:
        normalizedStatus,

      voterId:
        normalizedVoterId,

      timestamp:
        now,
    });


    crowdData[
      normalizedId
    ].updatedAt =
      new Date(
        now
      ).toISOString();


    /*
      サーバー側で共有回数を1回消費
    */
    recordGlobalShare(
      now
    );


    const result = {

      id:
        normalizedId,

      ...crowdData[
        normalizedId
      ],

      ...calculateCrowdStatus(
        crowdData[
          normalizedId
        ],
        now
      ),
    };


    const nextLimitState =
      getGlobalShareLimitState(
        now
      );


    broadcastCrowdUpdate();


    res.setHeader(
      "X-Crowd-Share-Limit",
      String(
        nextLimitState.limit
      )
    );

    res.setHeader(
      "X-Crowd-Share-Remaining",
      String(
        nextLimitState.remaining
      )
    );

    res.setHeader(
      "X-Crowd-Share-Retry-After-Ms",
      String(
        nextLimitState.retryAfterMs
      )
    );


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

      limit:
        nextLimitState.limit,

      used:
        nextLimitState.used,

      remaining:
        nextLimitState.remaining,

      retryAfterMs:
        nextLimitState.retryAfterMs,

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
