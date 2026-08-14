#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 options 表 ChatRoomTopicAgents 的 15 个 display_name 是否乱码"""
import sqlite3, json, sys

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
rows = con.execute("SELECT key, value FROM options WHERE key LIKE '%[Cc]hat%' OR key LIKE '%[Tt]opic%'").fetchall()
con.close()
for key, value in rows:
    print('== key:', key, 'len:', len(value or ''))
    if not value:
        continue
    try:
        data = json.loads(value)
    except Exception as e:
        print('  not json:', e)
        continue
    if isinstance(data, list):
        for ag in data:
            if isinstance(ag, dict):
                print('  -', repr(ag.get('source')), '| display:', repr(ag.get('display_name')), '| topic_source:', repr(ag.get('topic_source')))
    elif isinstance(data, dict):
        for k, v in list(data.items())[:10]:
            print('  ', k, '=', repr(v)[:120])
print('--- mojibake check ---')
for s in ['游戏观察员', '科技资讯观察员', '影视观察员', '财经观察员', '小红书观察员']:
    try:
        gbk = s.encode('utf-8').decode('gbk', errors='replace')
        print(repr(s), '-> utf8->gbk:', repr(gbk))
    except Exception as e:
        print('err', e)