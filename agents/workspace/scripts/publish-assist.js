#!/usr/bin/env node
// publish-assist.js — Step 3.7 Flash 发布助手
// 用法: node publish-assist.js "你的视频主题或截图描述"
// 需要: export STEP_API_KEY=sk-xxx

const STEP_KEY = process.env.STEP_API_KEY || "6mEueDE2756lFFUL04YCBmxFGg3h7QlikU6BH8A8yjbKPrcN0cIQqIPHBN97MXUoI";
const STEP_BASE = "https://api.stepfun.com/v1";

if (!STEP_KEY) {
  console.error("❌ 请先设置: export STEP_API_KEY=sk-xxx");
  console.error("   去 https://platform.stepfun.com/interface-key 获取");
  process.exit(1);
}

const fs = require("fs");
const topics = process.argv[2]
  ? [process.argv[2]]
  : (() => {
      try { return fs.readFileSync("topics.txt", "utf8").split("\n").filter(Boolean); }
      catch { return ["末世废土玄幻小说《再看，就把你瞪死》预告片，主角苏铭觉醒瞳术"]; }
    })();

async function* chat(messages) {
  const res = await fetch(`${STEP_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STEP_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "step-3.7-flash",
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {}
      }
    }
  }
}

function buildPrompt(topic) {
  return `你是短视频运营专家。根据以下视频内容，生成发布文案。

视频主题: ${topic}

请严格按此格式输出（不要多余内容）：

---抖音标题---
(20字以内，要有钩子、反差感)
---快手标题---
(接地气，口语化，15-25字)
---B站标题---
(二次元/玄幻风，可加括号副标题)
---标签---
(3列，每列用逗号分隔)
---简介---
(100字以内，有悬念感，不剧透)

直接输出，不要加解释。`;
}

async function main() {
  const results = [];
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i].trim();
    if (!topic) continue;
    if (topics.length > 1) console.log(`\n🎬 [${i + 1}/${topics.length}] ${topic.slice(0, 50)}...\n`);
    else console.log(`🎬 ${topic}\n`);

    let full = "";
    for await (const chunk of chat([{ role: "user", content: buildPrompt(topic) }])) {
      full += chunk;
    }
    console.log(full.trim());
    results.push({ topic, content: full.trim() });
  }
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━\n✅ ${results.length} 条全部生成完毕`);
}

main().catch((e) => {
  console.error("❌ 失败:", e.message);
});
