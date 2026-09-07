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

const PORT = process.env.PORT || 3000;


/* =========================================
   ミドルウェア
========================================= */

app.use(cors());

app.use(express.json());


/* =========================================
   設定
========================================= */

/*
  古い情報の影響を減らす時間

  1時間経過すると、
  その投稿の影響力は半分になります。
*/

const SCORE_HALF_LIFE_MS =
  60 * 60 * 1000;


/*
  投稿を保持する最大時間

  6時間より古い投稿は
  スコア計算に使用しません。
*/

const MAX_DATA_AGE_MS =
  6 * 60 * 60 * 1000;


/* =========================================
   混雑情報データ
========================================= */

/*
  データ形式

  {
    "modal1": [
      {
        status: "empty",
        updatedAt: "2026-09-07T..."
      },
      {
        status: "crowded",
        updatedAt: "2026-09-07T..."
      }
    ]
  }
*/

const crowdData = {};


/* =========================================
   ステータスをスコアに変換
========================================= */

function statusToScore(status){

  const scores = {

    empty:
      0,

    normal:
      50,

    crowded:
      100

  };


  return scores[status];

}


/* =========================================
   スコアからステータスを決定
========================================= */

function scoreToStatus(score){

  if(score < 34){

    return "empty";

  }


  if(score < 67){

    return "normal";

  }


  return "crowded";

}


/* =========================================
   古いデータを削除
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


            const age =
              now -
              new Date(
                item.updatedAt
              ).getTime();


            return age <=
              MAX_DATA_AGE_MS;

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
   企画ごとの混雑状況を計算
========================================= */

function calculateCrowdStatus(posts){

  if(
    !posts ||
    posts.length === 0
  ){

    return {

      status:
        "unknown",

      updatedAt:
        null,

      score:
        null

    };

  }


  const now =
    Date.now();


  let weightedScore =
    0;


  let totalWeight =
    0;


  let newestTime =
    null;


  posts.forEach(
    post => {


      const postTime =
        new Date(
          post.updatedAt
        ).getTime();


      const age =
        Math.max(
          0,
          now - postTime
        );


      /*
        時間が経過するほど
        重みを小さくする

        1時間で影響力が半分
      */

      const weight =
        Math.pow(
          0.5,
          age /
          SCORE_HALF_LIFE_MS
        );


      const score =
        statusToScore(
          post.status
        );


      if(
        typeof score !==
        "number"
      ){

        return;

      }


      weightedScore +=
        score * weight;


      totalWeight +=
        weight;


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


  if(
    totalWeight === 0
  ){

    return {

      status:
        "unknown",

      updatedAt:
        null,

      score:
        null

    };

  }


  const averageScore =
    weightedScore /
    totalWeight;


  return {

    status:
      scoreToStatus(
        averageScore
      ),

    updatedAt:
      newestTime,

    score:
      Math.round(
        averageScore
      )

  };

}


/* =========================================
   GET
   現在の全混雑情報を取得
========================================= */

app.get(
  "/api/crowd",
  (req, res) => {


    cleanOldData();


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


    res.status(200).json(
      result
    );

  }
);


/* =========================================
   POST
   混雑状況を共有
========================================= */

app.post(
  "/api/crowd",
  (req, res) => {


    const {
      id,
      status
    } = req.body;


    /* =====================================
       ID確認
    ===================================== */

    if(
      !id ||
      typeof id !== "string"
    ){

      return res.status(400).json({

        error:
          "企画IDが正しくありません"

      });

    }


    /* =====================================
       状態確認
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

      return res.status(400).json({

        error:
          "混雑状況が正しくありません"

      });

    }


    /* =====================================
       古いデータを削除
    ===================================== */

    cleanOldData();


    /* =====================================
       更新日時
    ===================================== */

    const updatedAt =
      new Date().toISOString();


    /* =====================================
       投稿データを追加
    ===================================== */

    if(
      !crowdData[id]
    ){

      crowdData[id] = [];

    }


    crowdData[id].push({

      status:
        status,

      updatedAt:
        updatedAt

    });


    /* =====================================
       現在の計算結果
    ===================================== */

    const calculated =
      calculateCrowdStatus(
        crowdData[id]
      );


    /* =====================================
       更新結果を返す
    ===================================== */

    res.status(200).json({

      id:
        id,

      status:
        calculated.status,

      updatedAt:
        calculated.updatedAt,

      score:
        calculated.score

    });

  }
);


/* =========================================
   動作確認用
========================================= */

app.get(
  "/",
  (req, res) => {

    res.status(200).json({

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

    res.status(200).json({

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

    res.status(404).json({

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
