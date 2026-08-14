#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计乱码消息 + 修复方案预览"""
import sqlite3, re

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')

def is_mojibake(s):
    """含 U+FFFD 或非中文常见字即视为乱码"""
    if not s:
        return False
    if '\ufffd' in s:
        return True
    # 检查是否有连续 2+ 个非 CJK/ASCII 的奇怪字符
    weird = re.findall(r'[\u0370-\u06FF\u0530-\u058F\u0080-\u02FF]', s)
    return len(weird) >= 2

print('== 乱码消息统计 ==')
rows = con.execute("SELECT id, room_group, username FROM chat_room_messages ORDER BY id").fetchall()
bad_msgs = [r for r in rows if is_mojibake(r[2])]
print('total messages:', len(rows), '| mojibake username:', len(bad_msgs))
for r in bad_msgs[:30]:
    print(' ', r[0], r[1], repr(r[2])[:30])

print('== 对话表乱码检查 ==')
crows = con.execute("SELECT id, type, name, room_group FROM chat_conversations ORDER BY id DESC LIMIT 30").fetchall()
for r in crows:
    mark = ' <<<' if is_mojibake(r[2] or '') else ''
    print(' ', r[0], r[1], repr(r[2])[:30], repr(r[3])[:20], mark)

print('== info-search 会话消息乱码检查（最近100条） ==')
for r in con.execute("SELECT id, room_group, username, substr(content,1,40) FROM chat_room_messages ORDER BY id DESC LIMIT 100").fetchall():
    if is_mojibake(r[2]):
        print('  MSG', r[0], r[1], repr(r[2])[:25], '|', repr(r[3]))
con.close()