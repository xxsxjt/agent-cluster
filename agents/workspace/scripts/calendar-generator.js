#!/usr/bin/env node
// calendar-generator.js — 从剧本生成30天发布日历+旁白脚本
const fs = require("fs");

const STEP_KEY = process.env.STEP_API_KEY || "4KzKaxhZcKFwgCo4N8B3nFvMNaHWPfomGxxZk46ird7vprhiVlLFbH5EAMYvD72Hr";
const STEP_BASE = "https://api.stepfun.com/v1";

const scriptRaw = fs.readFileSync("video-project/SCRIPT.md", "utf8");

async function* chat(messages) {
  const res = await fetch(`${STEP_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STEP_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "step-3.7-flash", messages, stream: true, temperature: 0.8, max_tokens: 4096 }),
  });
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const l of lines) {
      if (l.startsWith("data: ")) {
        const d = l.slice(6).trim();
        if (d === "[DONE]") return;
        try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) yield c; } catch {}
      }
    }
  }
}

async function main() {
  // ---- Phase 1: 30-day calendar ----
  console.log("📅 生成 30 天发布日历...\n");
  let cal = "";
  for await (const c of chat([{
    role: "user",
    content: `你是短视频运营专家。根据以下小说预告片剧本，生成完整的30天发布计划。

剧本:
${scriptRaw}

要求:
- 每天一个主题（共30条）
- 前7天：悬念钩子 + 世界观铺垫
- 第8-20天：角色介绍 + 高光桥段
- 第21-30天：剧情推进 + 决战预告
- 每条格式: Day N | 平台(抖音) | 主题一句话

直接输出30条，不要解释。`
  }])) cal += c;
  console.log(cal.trim());

  // ---- Phase 2: 旁白脚本（取前5天做演示）----
  console.log("\n\n🎙️ 批量生成旁白脚本（前5天演示）...\n");
  const days = cal.split("\n").filter(l => l.match(/^Day\s+\d+/)).slice(0, 5);
  
  for (const day of days) {
    const num = day.match(/Day\s+(\d+)/)?.[1];
    let script = "";
    for await (const c of chat([{
      role: "user",
      content: `你是短视频推文写手。根据以下主题，写一条30秒推文旁白脚本。

主题: ${day}

格式要求:
【画面描述】一句话
【旁白】（50-80字，口语化，有情绪起伏，开头3秒必须有钩子）
【字幕叠加】10字以内的冲击性文字

直接输出，不要解释。`
    }])) script += c;
    console.log(`\nDay ${num}`);
    console.log(script.trim());
    console.log("─".repeat(40));
  }

  console.log("\n✅ 日历 + 旁白脚本生成完毕");
  console.log("   单次成本约 ¥0.03，Pro 8000M 够跑 10 万次");
}

main().catch(e => console.error("❌", e.message));
