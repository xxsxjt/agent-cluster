#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
for t in chat_room_messages chat_room_topic_agents chat_moderation_findings chat_room_community_states chat_room_topic_memories; do
  echo "=== $t ==="
  sqlite3 "$DB" ".schema $t" 2>/dev/null | head -12
done
echo "=== 行数 ==="
sqlite3 "$DB" "SELECT 'messages', count(*) FROM chat_room_messages UNION ALL SELECT 'topic_agents', count(*) FROM chat_room_topic_agents UNION ALL SELECT 'moderation_findings', count(*) FROM chat_moderation_findings UNION ALL SELECT 'community_states', count(*) FROM chat_room_community_states UNION ALL SELECT 'topic_memories', count(*) FROM chat_room_topic_memories UNION ALL SELECT 'common_knowledges', count(*) FROM chat_room_common_knowledges;"
echo "=== messages 最新5条 ==="
sqlite3 -header "$DB" "SELECT id, room_id, substr(content,1,80) AS content, sender_role, created_at FROM chat_room_messages ORDER BY id DESC LIMIT 5;" 2>/dev/null
