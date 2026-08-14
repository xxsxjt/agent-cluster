#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 HK 聊天室 status 数据：频道名/topic 是否乱码"""
import sys, json, urllib.request

def main():
    tok = None
    try:
        import sqlite3
        con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
        row = con.execute("SELECT access_token FROM users WHERE username='root' LIMIT 1").fetchone()
        if row:
            tok = row[0]
        con.close()
    except Exception as e:
        print('token lookup failed:', e)
    if not tok:
        print('NO TOKEN')
        return
    req = urllib.request.Request('http://127.0.0.1:3461/api/chat-room/status',
                                 headers={'Authorization': 'Bearer ' + tok, 'New-Api-User': '1'})
    d = json.load(urllib.request.urlopen(req, timeout=15))
    data = d.get('data', {})
    print('groups:', json.dumps(data.get('groups', {}), ensure_ascii=False)[:400])
    tcs = data.get('topic_channels', [])
    print('topic_channels count:', len(tcs))
    for tc in tcs:
        print(repr(tc.get('channel_key')), '| display:', repr(tc.get('display_name')),
              '| topic:', repr(tc.get('topic_title'))[:100])

if __name__ == '__main__':
    main()