#!/bin/bash
# E2E verify: info-search (付费) — run on HK after deploy
set -e
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
API=http://127.0.0.1:3461
NOW=$(date +%s)
SUFFIX=$(date +%s)
USERNAME="infosearch_e2e_$SUFFIX"
TOKEN="sk-e2e-infosearch-$SUFFIX"

echo "===== [1] 创建测试用户 (quota=10,000,000 = 20余额) ====="
UID_RAW=$(sqlite3 "$DB" "INSERT INTO users (username,password,[group],[status],quota,access_token,aff_code,created_at) VALUES ('$USERNAME','x','default',1,10000000,'$TOKEN','e2e$SUFFIX',$NOW); SELECT last_insert_rowid();")
TESTUID=$(echo "$UID_RAW" | tail -1)
echo "user_id=$TESTUID token=$TOKEN"

echo "===== [2] 聊天室 status（服务在线+信息搜索计费规则） ====="
STATUS=$(curl -sS --max-time 20 -H "Authorization: Bearer $TOKEN" -H "New-Api-User: $TESTUID" $API/api/chat-room/status)
echo "$STATUS" | head -c 500
echo
echo "$STATUS" | python3 -c "import sys,json;d=json.load(sys.stdin);print('status.success=',d.get('success'));print('config.info_search_fee_per_reply=',d.get('data',{}).get('config',{}).get('info_search_fee_per_reply'));print('billing_text=',d.get('data',{}).get('config',{}).get('info_search_billing_text'))"

echo "===== [3] 创建信息搜索会话（幂等·每人独立） ====="
CONV=$(curl -sS --max-time 20 -X POST -H "Authorization: Bearer $TOKEN" -H "New-Api-User: $TESTUID" -H "Content-Type: application/json" -d '{"room_group":"default"}' $API/api/chat-room/conversations/info-search)
echo "$CONV" | head -c 400
echo
CID=$(echo "$CONV" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
CTYPE=$(echo "$CONV" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['type'])")
echo "conversation_id=$CID type=$CTYPE"

echo "===== [4] 再次创建（幂等验证） ====="
CONV2=$(curl -sS --max-time 20 -X POST -H "Authorization: Bearer $TOKEN" -H "New-Api-User: $TESTUID" -H "Content-Type: application/json" -d '{"room_group":"default"}' $API/api/chat-room/conversations/info-search)
CID2=$(echo "$CONV2" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
echo "again_id=$CID2 (应等于 $CID)"

echo "===== [5] 发消息触发信息搜索（多观察员+总管，每回复扣1余额） ====="
BEFORE=$(sqlite3 "$DB" "SELECT quota FROM users WHERE id=$TESTUID;")
echo "quota_before=$BEFORE"
curl -sS --max-time 300 -X POST -H "Authorization: Bearer $TOKEN" -H "New-Api-User: $TESTUID" -H "Content-Type: application/json" -d "{\"conversation_id\":$CID,\"content\":\"请追踪并搜索比对以下信息：2026年8月AI行业有哪些重大新闻事件？\"}" $API/api/chat-room/messages > /tmp/infosearch_resp.json 2>/tmp/infosearch_curl.err || echo "curl_exit=$?"
AFTER=$(sqlite3 "$DB" "SELECT quota FROM users WHERE id=$TESTUID;")
echo "quota_after=$AFTER"
echo "deducted=$(($BEFORE - $AFTER))"
echo "--- 响应摘要 ---"
python3 -c "
import json
d=json.load(open('/tmp/infosearch_resp.json'))
print('success=',d.get('success'))
print('message=',d.get('message'))
data=d.get('data')
if isinstance(data,dict):
    reps=data.get('replies',[])
    print('reply_count=',len(reps))
    for r in reps[:12]:
        print('  -', r.get('username'), '| status=',r.get('status'),'| model=',r.get('model_name'),'| head=',str(r.get('content'))[:60].replace(chr(10),' '))
" 2>&1 || cat /tmp/infosearch_resp.json | head -c 800

echo "===== [6] 数据库会话/消息落库 ====="
sqlite3 "$DB" "SELECT COUNT(*) AS convs FROM chat_conversations WHERE id=$CID;"
sqlite3 "$DB" "SELECT COUNT(*) AS msgs FROM chat_room_messages WHERE conversation_id=$CID;"
sqlite3 "$DB" "SELECT source_type, author_type, count(*) FROM chat_room_messages WHERE conversation_id=$CID GROUP BY source_type, author_type;"

echo "===== [7] 清理测试数据 ====="
sqlite3 "$DB" "DELETE FROM users WHERE id=$TESTUID; DELETE FROM tokens WHERE user_id=$TESTUID; DELETE FROM chat_conversations WHERE id=$CID; DELETE FROM chat_conversation_members WHERE conversation_id=$CID; DELETE FROM chat_room_messages WHERE conversation_id=$CID;"
echo "cleaned user_id=$TESTUID conv=$CID"
echo "===== E2E_DONE ====="
