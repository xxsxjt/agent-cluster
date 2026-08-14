#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按时间统计消息 + 检查 topic 标题"""
import sqlite3, datetime

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
def ts(t):
    return datetime.datetime.fromtimestamp(t).strftime('%m-%d %H:%M:%S') if t else '-'
print('== 18:30-19:30 消息 ==')
for r in con.execute("SELECT id, room_group, username, created_time, substr(content,1,40) FROM chat_room_messages WHERE created_time BETWEEN 1786523400 AND 1786527000 ORDER BY id").fetchall():
    print(r[0], r[1], '|', repr(r[2])[:18], '|', ts(r[3]), '|', repr(r[4]))
print('== 19:30-20:00 消息数 ==')
n = con.execute("SELECT count(*) FROM chat_room_messages WHERE created_time BETWEEN 1786527000 AND 1786528800").fetchone()[0]
print('count:', n)
print('== chat_room_topic_agents last_topic_title hex (新5频道) ==')
for r in con.execute("SELECT source, last_topic_title FROM chat_room_topic_agents WHERE source IN ('game','movie','it-news','caijing','xiaohongshu')").fetchall():
    t = r[1] or ''
    print(r[0], '| hex:', t.encode('utf-8').hex()[:80], '| repr:', repr(t)[:60])
con.close()