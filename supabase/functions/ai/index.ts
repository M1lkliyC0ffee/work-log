// supabase/functions/ai/index.ts
// DeepSeek-backed helper for the work-log app: task = "translate" | "suggest-plan".
// Deploy in Supabase dashboard (Edge Functions) and set the secret DEEPSEEK_API_KEY.
// SUPABASE_URL / SUPABASE_ANON_KEY are injected automatically by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 只允许已登录用户调用，避免陌生人白嫖你的 DeepSeek 额度
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Unauthorized" }, 401);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Unauthorized" }, 401);

  const key = Deno.env.get("DEEPSEEK_API_KEY");
  if (!key) return json({ error: "Server: DEEPSEEK_API_KEY is not set" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const task = body.task as string;
  const text = (body.text as string) || "";
  const cats = (body.cats as string) || "";
  let system = "";
  let temperature = 0.3;
  let jsonMode = false;
  let userContent = text;

  if (task === "translate") {
    system = "You are a professional translator. Translate the user's Chinese text into natural, clear, professional English. Output ONLY the translated text, with no explanations, no quotes, no extra words.";
  } else if (task === "suggest-plan") {
    jsonMode = true;
    temperature = 0.7;
    system = `你是一位资深设计导师（graphic designer / 视觉传达方向），擅长根据学员的实际工作问题，定制「周末补强练习」。

学员的长期方向是 graphic designer（视觉传达/平面设计）。下面会给出学员的「现有学习分类」和「本周工作记录」。请：
1. 找出他/她反复出现、或最影响效率的 2~3 个具体技能短板（例如：Illustrator 快捷键不熟、钢笔抠图不干净、溶图/调色拿不准、多尺寸适配慢、排版/字体、动效、3D、品牌策略等）。
2. 针对每个短板，给出这周末就能做、一次约 30–60 分钟的具体练习。
3. 每个建议归到一个分类：优先复用「现有分类」里的名字；如果都不合适，就建议一个新的分类名 + 一个合适的 emoji 图标（不要局限于 Illustrator/Photoshop 那几类，可以建议插画、动效、3D、品牌、排版等新方向）。

只输出 JSON（不要任何多余文字、不要 markdown 代码块），格式：
{"suggestions":[{"catName":"分类名","catIcon":"🎨","title":"简短练习名","why":"一句话说明为什么练（结合他的问题）","steps":["第一步","第二步","第三步"]}]}`;
    userContent = (cats ? "现有学习分类：" + cats + "\n\n" : "") + "本周工作记录：\n" + text;
  } else {
    return json({ error: "Unknown task: " + task }, 400);
  }

  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature,
    stream: false,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: "DeepSeek request failed", detail }, 502);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content ?? "";

  let result: Record<string, unknown>;
  if (jsonMode) {
    const cleaned = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      result = JSON.parse(cleaned);
    } catch {
      result = { suggestions: [], raw: content };
    }
  } else {
    result = { translation: String(content).trim() };
  }

  return json(result, 200);
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
