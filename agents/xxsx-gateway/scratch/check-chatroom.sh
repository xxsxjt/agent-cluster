#!/bin/bash
# 查 HK 聊天室 status 数据是否存在乱码
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "== users =="
sqlite3 "$DB" "SELECT id, username, role, status FROM users LIMIT 10;"
TOK=agnes
echo "== token len =="
echo "${#TOK}"
echo "== status =="
curl -s -H "Authorization: Bearer $TOK" -H "New-Api-User: 1" "http://127.0.0.1:3461/api/chat-room/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ok = d.get('success')
print('success:', ok)
data = d.get('data') or {}
if not ok:
    print('message:', d.get('message'))
    sys.exit(0)
print('groups:', json.dumps(data.get('groups', {}), ensure_ascii=False)[:400])
tcs = data.get('topic_channels', [])
print('topic_channels count:', len(tcs))
for tc in tcs:
    print(repr(tc.get('channel_key')), '| display:', repr(tc.get('display_name')), '| topic:', repr(tc.get('topic_title'))[:100])
"