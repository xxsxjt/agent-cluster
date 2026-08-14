#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "== chat_room_topic_memories schema =="
sqlite3 "$DB" "PRAGMA table_info(chat_room_topic_memories);" 2>&1 | head -15
echo "== last 15 rows =="
sqlite3 "$DB" "SELECT * FROM chat_room_topic_memories ORDER BY rowid DESC LIMIT 15;" 2>&1 | head -c 3000