#!/bin/bash
# 临时 root token 验证 chat-room API 返回（用完即删）
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
TOK="tmp-verify-$(date +%s)"
sqlite3 "$DB" "UPDATE users SET access_token='$TOK' WHERE id=1;"
echo "== option ChatRoomTopicAgents (内存+DB) =="
curl -s -H "Authorization: $TOK" -H "New-Api-User: 1" "http://127.0.0.1:3461/api/option/ChatRoomTopicAgents" | head -c 300
echo
echo "== chat-room/status topic_channels =="
curl -s -H "Authorization: $TOK" -H "New-Api-User: 1" "http://127.0.0.1:3461/api/chat-room/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success'):
    print('FAIL:', d.get('message'))
    sys.exit(0)
data = d['data']
print('groups:', json.dumps(data.get('groups', {}), ensure_ascii=False)[:300])
for tc in data.get('topic_channels', []):
    print(repr(tc.get('channel_key')), '|', repr(tc.get('display_name')), '|', repr(tc.get('topic_title'))[:60])
" 2>&1 | head -25
sqlite3 "$DB" "UPDATE users SET access_token='' WHERE id=1;"
echo "== token cleaned =="
sqlite3 "$DB" "SELECT length(access_token) FROM users WHERE id=1;"