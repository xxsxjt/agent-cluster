#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
# 上次游标 1786519805（2026-08-12 15:41 档案）
echo "=== messages 增量统计（游标后） ==="
sqlite3 "$DB" "SELECT count(*) FROM chat_room_messages WHERE created_time > 1786519805;"
echo "=== messages 增量按 room_group ==="
sqlite3 "$DB" "SELECT room_group, count(*) FROM chat_room_messages WHERE created_time > 1786519805 GROUP BY room_group ORDER BY count(*) DESC;"
echo "=== mem/kno 游标 ==="
sqlite3 "$DB" "SELECT (SELECT max(updated_at) FROM chat_room_topic_memories), (SELECT max(updated_at) FROM chat_room_common_knowledges), (SELECT count(*) FROM chat_room_common_knowledges WHERE updated_at > 1786519805);"
echo "=== messages 增量样例（前3条完整） ==="
sqlite3 -header "$DB" "SELECT id, room_group, username, author_type, model_name, content, created_time, source_type FROM chat_room_messages WHERE created_time > 1786519805 ORDER BY id LIMIT 3;" 2>/dev/null
