/* =========================================
   長高祭2026
   混雑情報共有API
========================================= */

const express = require("express");
const cors = require("cors");

const app = express();


/* =========================================
   基本設定
========================================= */

const PORT =
  process.env.PORT || 3000;


/* =========================================
   ミドルウェア
========================================= */

app.use(cors());

app.use(express.json());


/* =========================================
   混雑スコア設定
========================================= */

/*
  ステータスの基本点

  empty   = 0
  normal  = 50
  crowded = 100
*/

const STATUS_SCORES = {

  empty: 0,

  normal: 50,

  crowded: 100

};


/*
  時間減衰の半減期

  15分で重みが50%になる。

  例：

  0分   → 100%
  5分   → 約79%
  10分  → 約63%
  15分  → 50%
  20分  → 約40%
  30分  → 25%
  45分  → 約13%
  60分  → 約6%

*/

const SCORE_HALF_LIFE_MS =
  15 * 60 * 1000;


/*
  60分より古い投稿は
  混雑度の計算から除外する。
*/

const MAX_DATA_AGE_MS =
  60 * 60 * 1000;


/*
  少数票補正用の基準値。

  投票が少ない場合は
  「やや混雑」= 50点側へ
  少し引っ張る。

  これにより、

  1人だけが「混雑」と投稿

  ↓

  いきなり100点

  という現象を防ぐ。
*/

const PRIOR_SCORE =
  50;


/*
  基準値を何票分として扱うか。

  2.5にすることで、
  1票程度では極端な値にならず、
  投票数が増えると実際の投票結果へ
  徐々に近づく。
*/

const PRIOR_WEIGHT =
  2.5;


/*
  信頼度計算の係数。

  有効投票数が増えるほど
  信頼度が高くなる。

  おおよその目安：

  1有効票  → 約20%
  5有効票  → 約67%
  10有効票 → 約89%
  20有効票 → 約99%

*/

const CONFIDENCE_SCALE =
  4.5;


/* =========================================
   投稿制限
========================================= */

/*
  同じ投稿者が同じ企画へ
  短時間に大量投稿することを防ぐ。

  サーバー側でもチェックする。
*/

const VOTER_POST_INTERVAL_MS =
  5 * 60 * 1000;


/*
  投稿者履歴。

  key:

    voterId + "::" + 企画ID

  value:

    最後に投稿した時刻
*/

const voterPostHistory =
  new Map();


/* =========================================
   混雑情報データ
========================================= */

/*
  データ形式

  {
    "modal1":[

      {
        status:"empty",
        voterId:"xxxxxxxx",
        updatedAt:"2026-09-07T..."
      },

      {
        status:"crowded",
        voterId:"yyyyyyyy",
        updatedAt:"2026-09-07T..."
      }

    ]
  }

*/


const crowdData = {};


/* =========================================
   ステータス → スコア
========================================= */

function statusToScore(status){

  return STATUS_SCORES[
    status
  ];

}


/* =========================================
   スコア → ステータス
========================================= */

function scoreToStatus(score){

  if(
    score < 34
  ){

    return "empty";

  }


  if(
    score < 67
  ){

    return "normal";

  }


  return "crowded";

}


/* =========================================
   古いデータ削除
========================================= */

function cleanOldData(){

  const now =
    Date.now();


  Object.keys(
    crowdData
  ).forEach(
    id => {

      crowdData[id] =
        crowdData[id].filter(
          item => {

            if(
              !item ||
              typeof item !== "object"
            ){

              return false;

            }


            const postTime =
              new Date(
                item.updatedAt
              ).getTime();


            if(
              !Number.isFinite(
                postTime
              )
            ){

              return false;

            }


            const age =
              now -
              postTime;


            return (
              age >= 0 &&
              age <= MAX_DATA_AGE_MS
            );

          }
        );


      if(
        crowdData[id].length === 0
      ){

        delete crowdData[id];

      }

    }
  );

}


/* =========================================
   投稿者履歴の掃除
========================================= */

function cleanVoterHistory(){

  const now =
    Date.now();


  for(
    const [
      key,
      timestamp
    ]
    of voterPostHistory
  ){

    if(
      !Number.isFinite(
        timestamp
      ) ||
      now - timestamp >
        VOTER_POST_INTERVAL_MS
    ){

      voterPostHistory.delete(
        key
      );

    }

  }

}


/* =========================================
   同一投稿者の重複投稿整理
========================================= */

/*
  同じ voterId が同じ企画へ
  複数回投稿している場合、

  「その人の最新の1票だけ」

  を混雑スコア計算に使用する。

  これにより、

  1人が5分ごとに

  混雑
  ↓
  混雑
  ↓
  混雑
  ↓
  混雑

  と何度も送信しても、

  その人が4人分の票を
  持っているような状態にはならない。
*/

function getLatestVotesByVoter(posts){

  if(
    !Array.isArray(posts)
  ){

    return [];

  }


  const latestByVoter =
    new Map();


  posts.forEach(
    post => {

      if(
        !post ||
        typeof post !== "object"
      ){

        return;

      }


      const voterId =
        typeof post.voterId === "string"
          ? post.voterId
          : "";


      /*
        voterIdが存在しない古い形式の
        データについては、

        投稿そのものを1票として扱う。

        現在のPOSTでは必ず
        voterIdが保存される。
      */

      if(
        !voterId
      ){

        const anonymousKey =
          "__anonymous__" +
          Math.random()
            .toString(36)
            .slice(2);


        latestByVoter.set(
          anonymousKey,
          post
        );


        return;

      }


      const existing =
        latestByVoter.get(
          voterId
        );


      /*
        同じユーザーの場合、
        投稿日時が新しいものだけ残す。
      */

      if(
        !existing
      ){

        latestByVoter.set(
          voterId,
          post
        );

        return;

      }


      const currentTime =
        new Date(
          post.updatedAt
        ).getTime();


      const existingTime =
        new Date(
          existing.updatedAt
        ).getTime();


      if(
        Number.isFinite(
          currentTime
        ) &&
        (
          !Number.isFinite(
            existingTime
          ) ||
          currentTime >
            existingTime
        )
      ){

        latestByVoter.set(
          voterId,
          post
        );

      }

    }
  );


  return Array.from(
    latestByVoter.values()
  );

}


/* =========================================
   混雑状況計算
========================================= */

function calculateCrowdStatus(posts){

  if(
    !Array.isArray(posts) ||
    posts.length === 0
  ){

    return {

      status:
        "unknown",

      updatedAt:
        null,

      score:
        null,

      confidence:
        0,

      voteCount:
        0,

      effectiveVotes:
        0

    };

  }


  const now =
    Date.now();


  /*
    同じユーザーの複数投稿がある場合、
    最新の1票だけを使用する。

    これが大量連投対策の中心。
  */

  const latestVotes =
    getLatestVotesByVoter(
      posts
    );


  let weightedScore =
    PRIOR_SCORE *
    PRIOR_WEIGHT;


  let totalWeight =
    PRIOR_WEIGHT;


  let effectiveVotes =
    0;


  let voteCount =
    0;


  let newestTime =
    null;


  latestVotes.forEach(
    post => {

      if(
        !post ||
        typeof post !== "object"
      ){

        return;

      }


      const postTime =
        new Date(
          post.updatedAt
        ).getTime();


      if(
        !Number.isFinite(
          postTime
        )
      ){

        return;

      }


      const age =
        now -
        postTime;


      /*
        未来時刻は0分として扱う。
      */

      const safeAge =
        Math.max(
          0,
          age
        );


      /*
        60分より古いものは
        計算から除外。
      */

      if(
        safeAge >
        MAX_DATA_AGE_MS
      ){

        return;

      }


      const score =
        statusToScore(
          post.status
        );


      if(
        typeof score !== "number"
      ){

        return;

      }


      /*
        15分半減期の指数減衰。

        weight =
        0.5 ^ (経過時間 / 15分)
      */

      const weight =
        Math.pow(
          0.5,
          safeAge /
          SCORE_HALF_LIFE_MS
        );


      /*
        重みが極端に小さくなった
        投稿は実質的に無視する。
      */

      if(
        weight < 0.01
      ){

        return;

      }


      weightedScore +=
        score *
        weight;


      totalWeight +=
        weight;


      effectiveVotes +=
        weight;


      voteCount++;


      if(
        !newestTime ||
        postTime >
        new Date(
          newestTime
        ).getTime()
      ){

        newestTime =
          post.updatedAt;

      }

    }
  );


  /*
    実際に使用できる投票が
    1票もない場合。
  */

  if(
    voteCount === 0
  ){

    return {

      status:
        "unknown",

      updatedAt:
        null,

      score:
        null,

      confidence:
        0,

      voteCount:
        0,

      effectiveVotes:
        0

    };

  }


  /*
    加重平均。

    PRIOR_WEIGHT分の50点を
    最初から入れているため、
    少数票で極端なスコアになりにくい。
  */

  const averageScore =
    weightedScore /
    totalWeight;


  const finalScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          averageScore
        )
      )
    );


  /*
    信頼度。

    有効投票数が増えるほど
    100%へ近づく。

    これは正解率ではなく、
    「どれだけ情報が集まっているか」
    の目安。
  */

  const rawConfidence =
    1 -
    Math.exp(
      -effectiveVotes /
      CONFIDENCE_SCALE
    );


  const confidence =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          rawConfidence *
          100
        )
      )
    );


  return {

    status:
      scoreToStatus(
        finalScore
      ),

    updatedAt:
      newestTime,

    score:
      finalScore,

    confidence:
      confidence,

    voteCount:
      voteCount,

    effectiveVotes:
      Math.round(
        effectiveVotes *
        100
      ) / 100

  };

}


/* =========================================
   GET
   全混雑情報取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {

    cleanOldData();

    cleanVoterHistory();


    const result = {};


    Object.keys(
      crowdData
    ).forEach(
      id => {

        result[id] =
          calculateCrowdStatus(
            crowdData[id]
          );

      }
    );


    res
      .status(200)
      .json(
        result
      );

  }
);


/* =========================================
   POST
   混雑状況共有
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {


    const {
      id,
      status,
      voterId
    } =
      req.body;


    /* =====================================
       ID確認
    ===================================== */

    if(
      !id ||
      typeof id !== "string"
    ){

      return res
        .status(400)
        .json({

          error:
            "企画IDが正しくありません"

        });

    }


    /* =====================================
       ステータス確認
    ===================================== */

    const allowedStatuses = [

      "empty",

      "normal",

      "crowded"

    ];


    if(
      !allowedStatuses.includes(
        status
      )
    ){

      return res
        .status(400)
        .json({

          error:
            "混雑状況が正しくありません"

        });

    }


    /* =====================================
       投稿者ID確認
    ===================================== */

    if(
      !voterId ||
      typeof voterId !== "string" ||
      voterId.length < 10 ||
      voterId.length > 200
    ){

      return res
        .status(400)
        .json({

          error:
            "投稿者情報を確認できませんでした。ページを再読み込みしてください。"

        });

    }


    /* =====================================
       古いデータ整理
    ===================================== */

    cleanOldData();

    cleanVoterHistory();


    /* =====================================
       サーバー側投稿制限
    ===================================== */

    const voterKey =
      voterId +
      "::" +
      id;


    const lastPostTime =
      voterPostHistory.get(
        voterKey
      );


    if(
      Number.isFinite(
        lastPostTime
      )
    ){

      const elapsed =
        Date.now() -
        lastPostTime;


      const remaining =
        VOTER_POST_INTERVAL_MS -
        elapsed;


      if(
        remaining > 0
      ){

        const remainingSeconds =
          Math.ceil(
            remaining /
            1000
          );


        return res
          .status(429)
          .json({

            error:
              "同じ企画への共有は5分に1回までです。あと" +
              remainingSeconds +
              "秒お待ちください。",

            remainingMs:
              remaining

          });

      }

    }


    /* =====================================
       投稿日時
    ===================================== */

    const updatedAt =
      new Date()
        .toISOString();


    /* =====================================
       投稿者履歴記録
    ===================================== */

    voterPostHistory.set(
      voterKey,
      Date.now()
    );


    /* =====================================
       データ追加
    ===================================== */

    if(
      !crowdData[id]
    ){

      crowdData[id] =
        [];

    }


    crowdData[id].push({

      status:
        status,

      voterId:
        voterId,

      updatedAt:
        updatedAt

    });


    /* =====================================
       現在のスコア計算
    ===================================== */

    const calculated =
      calculateCrowdStatus(
        crowdData[id]
      );


    /* =====================================
       結果返却
    ===================================== */

    res
      .status(200)
      .json({

        id:
          id,

        status:
          calculated.status,

        score:
          calculated.score,

        confidence:
          calculated.confidence,

        voteCount:
          calculated.voteCount,

        effectiveVotes:
          calculated.effectiveVotes,

        updatedAt:
          calculated.updatedAt

      });

  }
);


/* =========================================
   動作確認
========================================= */

app.get(
  "/",
  (req, res) => {

    res
      .status(200)
      .json({

        message:
          "長高祭2026 混雑情報APIは正常に動作しています"

      });

  }
);


/* =========================================
   ヘルスチェック
========================================= */

app.get(
  "/health",
  (req, res) => {

    res
      .status(200)
      .json({

        status:
          "ok"

      });

  }
);


/* =========================================
   404
========================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        error:
          "ページが見つかりません"

      });

  }
);


/* =========================================
   サーバー起動
========================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server is running on port ${PORT}`
    );

  }
);
