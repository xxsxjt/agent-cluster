#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复 chat_room_messages 乱码 username：按乱码模式映射到正确 display_name
乱码 = 名字的 GBK 字节被按 UTF-8 解码（非法字节→U+FFFD）后再 UTF-8 编码存库
模式可从正确的名字重现： name.encode('gbk').decode('utf-8', errors='replace').encode('utf-8')
"""
import sqlite3, sys

DB = '/data/xxsx-api/new-api-data/xxsx-new-api.db'
NAMES = ['游戏观察员', '影视观察员', '科技资讯观察员', '财经观察员', '小红书观察员', '腾讯新闻观察员']

def mojibake_hex(name):
    """生成乱码字节hex: GBK字节 -> 按UTF-8解码(replace) -> UTF-8编码"""
    return name.encode('gbk').decode('utf-8', errors='replace').encode('utf-8').hex()

PATTERNS = {mojibake_hex(n): n for n in NAMES}
print('patterns:', {k[:16]: v for k, v in PATTERNS.items()})

con = sqlite3.connect(DB)
rows = con.execute("SELECT id, username FROM chat_room_messages").fetchall()
updated = []
for mid, username in rows:
    if not username:
        continue
    h = username.encode('utf-8', errors='surrogateescape').hex()
    if h in PATTERNS:
        updated.append((mid, PATTERNS[h], username))
print('to fix:', len(updated))
if not updated:
    con.close()
    sys.exit(0)
for mid, name, old in updated[:35]:
    print(' ', mid, repr(old)[:20], '->', name)
# 执行更新
for mid, name, _ in updated:
    con.execute("UPDATE chat_room_messages SET username=? WHERE id=?", (name, mid))
con.commit()
# 验证
remain = con.execute("SELECT count(*) FROM chat_room_messages WHERE username LIKE '%\ufffd%'").fetchone()[0]
print('remaining mojibake username:', remain)
con.close()
print('DONE')