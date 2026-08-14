#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "== tables (chat) =="
sqlite3 "$DB" ".tables" | tr ' ' '\n' | grep -iE "chat|topic"
echo "== topic channel agents option =="
sqlite3 "$DB" "SELECT value FROM options WHERE key LIKE 'ChatRoom%' LIMIT 3;" 2>/dev/null | head -c 2000
echo
echo "== chat_room_topics sample =="
sqlite3 "$DB" "SELECT * FROM chat_room_topics ORDER BY id DESC LIMIT 10;" 2>&1 | head -20