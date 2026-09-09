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
  サイト全体で10分間に5回まで
*/
const GLOBAL_SHARE_LIMIT = 100;

const GLOBAL_SHARE_WINDOW_MS =
  10 * 60 * 1000;


/*
  同じ人が同じカードへ再共有できるまで
  5分間
*/
const SAME_CARD_SHARE_COOLDOWN_MS =
  5 * 60 * 1000;


/*
  混雑情報の時間減衰

  30分で影響力が半分
*/
const CROWD_DECAY_HALF_LIFE_MS =
  30 * 60 * 1000;


/*
  全体共有履歴
*/
const globalShareHistory = [];


/*
  管理画面から非表示にしたカード
*/
const hiddenCrowdIds = new Set();


/*
  混雑情報共有機能

  初期状態はOFF
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

  if (
    Date.now() -
      session.createdAt >
    ADMIN_SESSION_MAX_AGE_MS
  ) {

    adminSessions.delete(
      token
    );

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

function getScoreFromStatus(status) {

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
    新方式では各共有を
    votes配列として保存
  */
  let votes =
    Array.isArray(data.votes)
      ? data.votes
      : [];


  /*
    旧方式のデータとの互換性

    votesがない場合は、
    updatedAtとstatusから
    仮想的な1票を作る
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
      votes = [
        {
          status:
            typeof data.status === "string"
              ? data.status
              : "unknown",
          timestamp:
            legacyTimestamp,
        },
      ];
    }
  }


  /*
    新方式の計算

    ・30分半減期の時間減衰
    ・極端な少数票に引っ張られすぎない事前分布
    ・回答の一致度を信頼度へ反映
    ・情報の古さも信頼度へ反映
  */
  if (
    votes.length > 0
  ) {

    let weightedScoreSum = 0;
    let weightedScoreSquaredSum = 0;
    let effectiveVotes = 0;
    let validVoteCount = 0;
    let weightedAgeSum = 0;


    for (
      const vote of votes
    ) {

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


      /*
        半減期30分
        古い情報ほど指数関数的に影響を小さくする
      */
      const weight =
        Math.pow(
          0.5,
          age /
            CROWD_DECAY_HALF_LIFE_HALF_LIFE_MS
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


      validVoteCount += 1;
      effectiveVotes += weight;
      weightedScoreSum +=
        voteScore * weight;
      weightedScoreSquaredSum +=
        voteScore *
        voteScore *
        weight;
      weightedAgeSum +=
        age * weight;
    }


    /*
      ほぼ完全に情報が消えた場合
    */
    if (
      effectiveVotes <= 0.01
    ) {
      return {
        status: "unknown",
        label: "情報なし",
        score: null,
        confidence: 0,
        voteCount: validVoteCount,
        effectiveVotes: 0,
      };
    }


    const weightedAverage =
      weightedScoreSum /
      effectiveVotes;


    /*
      分散を計算して、回答の一致度を求める

      スコア範囲は10～90なので、
      最大分散を1600として正規化する。
      みんなの回答が近いほど1に近づき、
      10と90のように大きく割れるほど0に近づく。
    */
    const weightedSecondMoment =
      weightedScoreSquaredSum /
      effectiveVotes;


    const weightedVariance =
      Math.max(
        0,
        weightedSecondMoment -
          weightedAverage *
          weightedAverage
      );


    const agreement =
      Math.max(
        0,
        Math.min(
          1,
          1 -
            weightedVariance /
              1600
        )
      );


    /*
      スコア計算

      50を「情報がないときの中立値」とし、
      少数票では中立値を少し残す。
      票が十分に集まるほど実測値へ近づく。

      事前分布2票相当を使用することで、
      1票だけの極端な評価による過大反応を防ぐ。
    */
    const PRIOR_EFFECTIVE_VOTES = 2;

    const score =
      (
        weightedScoreSum +
        50 * PRIOR_EFFECTIVE_VOTES
      ) /
      (
        effectiveVotes +
        PRIOR_EFFECTIVE_VOTES
      );


    /*
      信頼度計算

      1. 有効票数が増えるほど上昇
      2. 回答が一致しているほど上昇
      3. 情報が新しいほど上昇

      票数だけで高信頼度にならないようにする。
    */
    const quantityConfidence =
      1 -
      Math.exp(
        -effectiveVotes / 5
      );


    const weightedAverageAge =
      weightedAgeSum /
      effectiveVotes;


    const freshnessConfidence =
      Math.exp(
        -weightedAverageAge /
          (45 * 60 * 1000)
      );


    const confidence =
      100 *
      quantityConfidence *
      agreement *
      freshnessConfidence;


    let status =
      "unknown";
    let label =
      "情報なし";


    if (
      score >= 82
    ) {
      status =
        "very-crowded";
      label =
        "かなり混雑";
    }
    else if (
      score >= 62
    ) {
      status =
        "crowded";
      label =
        "混雑";
    }
    else if (
      score >= 35
    ) {
      status =
        "normal";
      label =
        "やや混雑";
    }
    else {
      status =
        "empty";
      label =
        "空いています";
    }


    /*
      情報の影響がほぼ消えたら
      情報なし
    */
    if (
      effectiveVotes < 0.10
    ) {
      status =
        "unknown";
      label =
        "情報なし";
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
            Math.round(
              confidence
            )
          )
        ),
      voteCount:
        validVoteCount,
      effectiveVotes:
        Number(
          effectiveVotes.toFixed(3)
        ),
    };
  }


  /*
    旧形式データ
  */
  const savedStatus =
    typeof data.status === "string"
      ? data.status
      : "";


  const scoreNumber =
    Number(
      data.score
    );

  const confidenceNumber =
    Number(
      data.confidence
    );

  const voteCountNumber =
    Number(
      data.voteCount
    );

  const effectiveVotesNumber =
    Number(
      data.effectiveVotes
    );


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
    empty:
      "空いています",
    normal:
      "やや混雑",
    crowded:
      "混雑",
    "very-crowded":
      "かなり混雑",
    unknown:
      "情報なし",
  };


  return {
    status:
      savedStatus,
    label:
      labelMap[
        savedStatus
      ] ||
      "情報なし",
    score,
    confidence,
    voteCount,
    effectiveVotes,
  };
}

/* =========================================
   全体共有制限
========================================= */

function pruneGlobalShareHistory(
  now = Date.now()
) {

  const cutoff =
    now -
    GLOBAL_SHARE_WINDOW_MS;


  while (
    globalShareHistory.length >
      0 &&
    globalShareHistory[0] <=
      cutoff
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

    }
    catch (
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

      success:
        true,

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

      success:
        true,
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
   管理者状態取得
========================================= */

app.get(
  "/api/admin/state",
  requireAdmin,
  (req, res) => {

    cleanOldData();


    const visibleCrowdData =
      {};


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
        一般公開側には
        非表示カードを出さない
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

      success:
        true,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),

      /*
        admin.html が使用
      */
      crowdData:
        visibleCrowdData,

      allCrowdData,
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
      混雑情報を完全リセット
    */
    crowdData =
      {};


    /*
      全体共有制限もリセット
    */
    globalShareHistory.length =
      0;


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

      message:
        "混雑状況をリセットしました。",
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

      success:
        true,

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

        success:
          false,

        message:
          "enabled は true または false にしてください。",
      });
    }


    crowdSharingEnabled =
      enabled;


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

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

        success:
          false,

        message:
          "IDが指定されていません。",
      });
    }


    hiddenCrowdIds.add(
      id
    );


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

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

        success:
          false,

        message:
          "IDが指定されていません。",
      });
    }


    hiddenCrowdIds.delete(
      id
    );


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),
    });
  }
);


/* =========================================
   全体共有制限状態取得
========================================= */

app.get(
  "/api/crowd/limit",
  (req, res) => {

    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    res.json(
      getGlobalShareLimitState()
    );
  }
);


/* =========================================
   混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    cleanOldData();


    const limitState =
      getGlobalShareLimitState();


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


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
        非表示カードは
        一般公開しない
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
      共有機能OFF
    */
    if (
      crowdSharingEnabled !==
      true
    ) {

      return res.status(403).json({

        success:
          false,

        error:
          "現在、混雑状況の共有は停止しています。",
      });
    }


    const now =
      Date.now();


    const {
      id,
      status,
      voterId
    } =
      req.body || {};


    /*
      ID確認
    */
    if (!id) {

      return res.status(400).json({

        success:
          false,

        error:
          "企画IDが指定されていません。",
      });
    }


    const normalizedId =
      String(
        id
      ).trim();


    /*
      status確認
    */
    if (
      typeof status !==
        "string" ||
      !status.trim()
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          "混雑状況が指定されていません。",
      });
    }


    const normalizedStatus =
      status.trim();


    /*
      有効なstatusか確認
    */
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

        success:
          false,

        error:
          "無効な混雑状況です。",
      });
    }


    /*
      voterId
    */
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


    /* =====================================
       同じ人・同じカードの5分制限
    ===================================== */

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
              vote.voterId ||
                ""
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

              success:
                false,

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

    }
    catch (
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

      success:
        true,

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

      success:
        true,
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
   管理者状態取得
========================================= */

app.get(
  "/api/admin/state",
  requireAdmin,
  (req, res) => {

    cleanOldData();


    const visibleCrowdData =
      {};


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
        一般公開側には
        非表示カードを出さない
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

      success:
        true,

      sharingEnabled:
        crowdSharingEnabled,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),

      /*
        admin.html が使用
      */
      crowdData:
        visibleCrowdData,

      allCrowdData,
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
      混雑情報を完全リセット
    */
    crowdData =
      {};


    /*
      全体共有制限もリセット
    */
    globalShareHistory.length =
      0;


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

      message:
        "混雑状況をリセットしました。",
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

      success:
        true,

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

        success:
          false,

        message:
          "enabled は true または false にしてください。",
      });
    }


    crowdSharingEnabled =
      enabled;


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

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

        success:
          false,

        message:
          "IDが指定されていません。",
      });
    }


    hiddenCrowdIds.add(
      id
    );


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

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

        success:
          false,

        message:
          "IDが指定されていません。",
      });
    }


    hiddenCrowdIds.delete(
      id
    );


    broadcastCrowdUpdate();


    res.json({

      success:
        true,

      hiddenIds:
        Array.from(
          hiddenCrowdIds
        ),
    });
  }
);


/* =========================================
   全体共有制限状態取得
========================================= */

app.get(
  "/api/crowd/limit",
  (req, res) => {

    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    res.json(
      getGlobalShareLimitState()
    );
  }
);


/* =========================================
   混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    cleanOldData();


    const limitState =
      getGlobalShareLimitState();


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


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
        非表示カードは
        一般公開しない
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
      共有機能OFF
    */
    if (
      crowdSharingEnabled !==
      true
    ) {

      return res.status(403).json({

        success:
          false,

        error:
          "現在、混雑状況の共有は停止しています。",
      });
    }


    const now =
      Date.now();


    const {
      id,
      status,
      voterId
    } =
      req.body || {};


    /*
      ID確認
    */
    if (!id) {

      return res.status(400).json({

        success:
          false,

        error:
          "企画IDが指定されていません。",
      });
    }


    const normalizedId =
      String(
        id
      ).trim();


    /*
      status確認
    */
    if (
      typeof status !==
        "string" ||
      !status.trim()
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          "混雑状況が指定されていません。",
      });
    }


    const normalizedStatus =
      status.trim();


    /*
      有効なstatusか確認
    */
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

        success:
          false,

        error:
          "無効な混雑状況です。",
      });
    }


    /*
      voterId
    */
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


    /* =====================================
       同じ人・同じカードの5分制限
    ===================================== */

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
              vote.voterId ||
                ""
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

              success:
                false,

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

              retryAfterMs:
                retryAfterMs,

              nextShareAllowedAt:
                previousTimestamp +
                SAME_CARD_SHARE_COOLDOWN_MS,
            });
          }
        }
      }
    }


    /* =====================================
       サイト全体の5回/10分制限
    ===================================== */

    const limitState =
      getGlobalShareLimitState(
        now
      );


    if (
      limitState.remaining <=
      0
    ) {

      const retrySeconds =
        Math.ceil(
          limitState.retryAfterMs /
            1000
        );


      return res.status(429).json({

        success:
          false,

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


    /* =====================================
       カードデータ作成
    ===================================== */

    if (
      !existing ||
      typeof existing !==
        "object"
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

    }
    else if (
      !Array.isArray(
        existing.votes
      )
    ) {

      existing.votes =
        [];
    }


    /* =====================================
       同じ人の古い票を削除
    ===================================== */

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
              vote.voterId ||
                ""
            ) !==
              normalizedVoterId
        );
    }


    /* =====================================
       新しい票を追加
    ===================================== */

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
      全体共有回数を1回消費
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


    /*
      リアルタイム通知
    */
    broadcastCrowdUpdate();


    /*
      ヘッダー
    */
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


    /*
      レスポンス
    */
    res.json({

      success:
        true,

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


    if (
      hiddenCrowdIds.has(
        id
      )
    ) {

      return res.status(404).json({

        success:
          false,

        error:
          "混雑情報が見つかりません。",
      });
    }


    const data =
      crowdData[id];


    if (!data) {

      return res.status(404).json({

        success:
          false,

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

              nextShareAllowedAt:
                previousTimestamp +
                SAME_CARD_SHARE_COOLDOWN_MS,
            });
          }
        }
      }
    }


    /* =====================================
       サイト全体の5回/10分制限
    ===================================== */

    const limitState =
      getGlobalShareLimitState(
        now
      );


    if (
      limitState.remaining <=
      0
    ) {

      const retrySeconds =
        Math.ceil(
          limitState.retryAfterMs /
            1000
        );


      return res.status(429).json({

        success:
          false,

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


    /* =====================================
       カードデータ作成
    ===================================== */

    if (
      !existing ||
      typeof existing !==
        "object"
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

    }
    else if (
      !Array.isArray(
        existing.votes
      )
    ) {

      existing.votes =
        [];
    }


    /* =====================================
       同じ人の古い票を削除
    ===================================== */

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
              vote.voterId ||
                ""
            ) !==
              normalizedVoterId
        );
    }


    /* =====================================
       新しい票を追加
    ===================================== */

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
      全体共有回数を1回消費
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


    /*
      リアルタイム通知
    */
    broadcastCrowdUpdate();


    /*
      ヘッダー
    */
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


    /*
      レスポンス
    */
    res.json({

      success:
        true,

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


    if (
      hiddenCrowdIds.has(
        id
      )
    ) {

      return res.status(404).json({

        success:
          false,

        error:
          "混雑情報が見つかりません。",
      });
    }


    const data =
      crowdData[id];


    if (!data) {

      return res.status(404).json({

        success:
          false,

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

        success:
          false,

        error:
          "混雑情報が見つかりません。",
      });
    }


    delete crowdData[id];


    hiddenCrowdIds.delete(
      id
    );


    broadcastCrowdUpdate();


    res.json({

      success:
        true,
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
      接続直後に現在の状態
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

          }
          catch (
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

      success:
        false,

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
