#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "== chat_room_messages schema =="
sqlite3 "$DB" "PRAGMA table_info(chat_room_messages);" 2>&1 | head -12
echo "== recent 20 messages (content snippet) =="
sqlite3 "$DB" "SELECT id, room_group, username, substr(content,1,60), status FROM chat_room_messages ORDER BY id DESC LIMIT 20;" 2>&1 | head -25
echo "== conversation titles =="
sqlite3 "$DB" "SELECT id, type, title, room_group FROM chat_conversations ORDER BY id DESC LIMIT 10;" 2>&1 | head -12