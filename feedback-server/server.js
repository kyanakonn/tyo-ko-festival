const express = require("express");
const cors = require("cors");

const { createClient } =
require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get("/", (req,res)=>{
  res.send("Feedback API Running");
});

app.post("/api/feedback", async (req,res)=>{

  try{

    const {
      category,
      message
    } = req.body;

    const { error } =
      await supabase
      .from("feedbacks")
      .insert([
        {
          category,
          message
        }
      ]);

    if(error) throw error;

    res.json({
      success:true
    });

  }catch(err){

    console.error(err);

    res.status(500).json({
      success:false
    });

  }

});

app.get("/api/feedback", async (req,res)=>{

  const { data,error } =
    await supabase
      .from("feedbacks")
      .select("*")
      .order(
        "created_at",
        { ascending:false }
      );

  if(error){
    return res.status(500).json([]);
  }

  res.json(data);
});

const PORT =
process.env.PORT || 3000;

app.listen(PORT,()=>{
  console.log(
    `Server running on ${PORT}`
  );
});
