#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "=== messages 最新8条 ==="
sqlite3 -header "$DB" "SELECT id, room_group, username, author_type, model_name, substr(content,1,120) AS content, created_time, source_type FROM chat_room_messages ORDER BY id DESC LIMIT 8;" 2>/dev/null
echo ""
echo "=== messages 按 room_group 计数 ==="
sqlite3 "$DB" "SELECT room_group, count(*) FROM chat_room_messages GROUP BY room_group ORDER BY count(*) DESC;" 2>/dev/null
echo ""
echo "=== 最近消息时间范围 ==="
sqlite3 "$DB" "SELECT min(created_time), max(created_time) FROM chat_room_messages;" 2>/dev/null
echo ""
echo "=== topic_agents 列表 ==="
sqlite3 -header "$DB" "SELECT id, source, channel_key, display_name, model_name, substr(last_topic_title,1,50) AS last_topic, updated_time FROM chat_room_topic_agents;" 2>/dev/null
echo ""
echo "=== common_knowledges 最新10条(按updated_at) ==="
sqlite3 -header "$DB" "SELECT id, topic, status, updated_at FROM chat_room_common_knowledges ORDER BY updated_at DESC LIMIT 10;" 2>/dev/null
