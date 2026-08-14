TOK=c87321630599473d3fb04e069f37e803
BASE=http://127.0.0.1:3461
echo "==[1] LIST kind=twin (本机分身虚拟会话)=="
curl -s -H "Authorization: Bearer $TOK" -H "New-Api-User: 1" "$BASE/api/admin/assistant/conversations?kind=twin"
echo; echo
echo "==[2] MESSAGES sentinel -1000 尾部3条=="
curl -s -H "Authorization: Bearer $TOK" -H "New-Api-User: 1" "$BASE/api/admin/assistant/conversations/-1000/messages" | python3 -c "import sys,json; d=json.load(sys.stdin); ms=d['data'][-3:]; [print(m['role'],'|',m['content'][:60]) for m in ms]"
echo
echo "==[3] LIST kind=manual (Hermes 保留) 数量=="
curl -s -H "Authorization: Bearer $TOK" -H "New-Api-User: 1" "$BASE/api/admin/assistant/conversations?kind=manual" | python3 -c "import sys,json; d=json.load(sys.stdin); print('manual conversations:',len(d['data']),'kinds:',set(c['kind'] for c in d['data']))"
echo
echo "==[4] SEND 首条(若空)/测试消息=="
curl -s -X POST -H "Authorization: Bearer $TOK" -H "New-Api-User: 1" -H "Content-Type: application/json" -d '{"message":"测试：从管理端助手给分身发一条"}' "$BASE/api/admin/assistant/conversations/-1000/messages" | python3 -c "import sys,json; d=json.load(sys.stdin); a=d['data']['assistant_message']; print('success:',d['success'],'| reply:',a['content'][:80])"
