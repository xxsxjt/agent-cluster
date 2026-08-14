#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对比消息时间与配置表更新时间"""
import sqlite3, datetime

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
def ts(t):
    return datetime.datetime.fromtimestamp(t).strftime('%m-%d %H:%M:%S') if t else '-'
print('== messages 9300-9316 times ==')
for r in con.execute("SELECT id, room_group, username, created_time, status FROM chat_room_messages WHERE id BETWEEN 9300 AND 9320 ORDER BY id").fetchall():
    print(r[0], r[1], '|', repr(r[2])[:20], '|', ts(r[3]), '|', r[4])
print('== topic_agents updated_time ==')
for r in con.execute("SELECT source, display_name, topic_claim_until, updated_time FROM chat_room_topic_agents WHERE source IN ('game','movie','it-news','caijing','xiaohongshu','bilibili')").fetchall():
    print(r[0], repr(r[1])[:20], '| claim_until:', ts(r[2]), '| updated:', ts(r[3]))
con.close()