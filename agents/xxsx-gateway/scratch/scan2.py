#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查剩余 U+FFFD 行详情（chat_room_messages 重点）"""
import sqlite3

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
print('== chat_room_messages content with FFFD ==')
for r in con.execute("SELECT id, room_group, username, substr(content, 1, 100) FROM chat_room_messages WHERE content LIKE '%\ufffd%'").fetchall():
    print(' ', r[0], r[1], repr(r[2])[:25], '|', repr(r[3]))
print('== admin_mobile_alerts message FFFD ==')
for r in con.execute("SELECT id, message FROM admin_mobile_alerts WHERE message LIKE '%\ufffd%' ORDER BY id DESC LIMIT 5").fetchall():
    print(' ', r[0], repr(r[1])[:100])
con.close()