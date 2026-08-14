#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 options 表 ChatRoom 相关配置的 display_name"""
import sqlite3, json

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
rows = con.execute("SELECT key, value FROM options WHERE key LIKE '%Chat%' OR key LIKE '%Topic%'").fetchall()
con.close()
print('rows:', len(rows))
for key, value in rows:
    print('== key:', key, 'len:', len(value or ''))
    if not value:
        continue
    try:
        data = json.loads(value)
    except Exception as e:
        print('  not json:', str(e)[:80])
        continue
    if isinstance(data, list):
        for ag in data:
            if isinstance(ag, dict):
                print('  -', repr(ag.get('source')), '| topic_source:', repr(ag.get('topic_source')),
                      '| display:', repr(ag.get('display_name')), '| model:', repr(ag.get('model')))
    elif isinstance(data, dict):
        for k, v in list(data.items())[:12]:
            print('  ', k, '=', repr(v)[:150])