#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""消息 username 原始字节 hex"""
import sqlite3

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
for r in con.execute("SELECT id, room_group, username FROM chat_room_messages WHERE id IN (9307,9308,9309,9310,9311,9312,9305,9306,9313) ORDER BY id").fetchall():
    raw = r[2].encode('utf-8', errors='surrogateescape')
    print(r[0], r[1], '| len:', len(raw), '| hex:', raw.hex())
    # 尝试各种解码
    if r[2]:
        for enc in ('utf-8', 'gbk', 'gb18030'):
            try:
                print('   ', enc, '->', r[2].encode('latin1').decode(enc) if False else r[2])
            except Exception:
                pass
print('== 配置表对照 ==')
for r in con.execute("SELECT source, display_name FROM chat_room_topic_agents WHERE source IN ('game','tencent-news','xiaohongshu')").fetchall():
    print(r[0], '| hex:', r[1].encode('utf-8').hex(), '| repr:', repr(r[1]))
con.close()