#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 chat_room_topic_agents 表"""
import sqlite3, json

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
cur = con.execute("PRAGMA table_info(chat_room_topic_agents)").fetchall()
print('schema:', [c[1] for c in cur])
rows = con.execute("SELECT * FROM chat_room_topic_agents ORDER BY id").fetchall()
con.close()
print('rows:', len(rows))
for r in rows:
    print(r[0], "|", r[1], "|", repr(r[4])[:40], "| model:", repr(r[5])[:30], "| role:", repr(r[17])[:40] if len(r)>17 else "")