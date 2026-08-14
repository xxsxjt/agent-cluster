#!/bin/bash
# 用用户 token 调 chat-room/status（不带 Bearer 前缀）
for AUTH in "agnes" "Bearer agnes"; do
  echo "== AUTH=$AUTH =="
  curl -s -H "Authorization: $AUTH" -H "New-Api-User: 1" "http://127.0.0.1:3461/api/chat-room/status" | head -c 600
  echo
done