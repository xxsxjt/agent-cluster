#!/bin/bash
node -e '
const fs=require("fs");
const rows=fs.readFileSync("/data/agent-cluster/knowledge/observer-intel/entries/2026-08-12.jsonl","utf8").trim().split("\n").map(l=>JSON.parse(l));
const kw="\u7070\u4ea7";
const hits=rows.filter(r=>JSON.stringify(r).includes(kw));
console.log("HK_retrieval_hits:",hits.length,"/",rows.length,"条");
console.log("channels:",[...new Set(hits.map(r=>r.room_group).filter(Boolean))].join(","));
const topicHits=hits.filter(r=>r.kind==="knowledge").map(r=>r.topic);
console.log("knowledge_topics:",topicHits.slice(0,3).join(" | "));
'
