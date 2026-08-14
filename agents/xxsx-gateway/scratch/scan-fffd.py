#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全库扫描含 U+FFFD 或可疑字符的 text 数据"""
import sqlite3

con = sqlite3.connect('/data/xxsx-api/new-api-data/xxsx-new-api.db')
tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
for t in tables:
    cols = [r for r in con.execute(f"PRAGMA table_info({t})").fetchall() if 'TEXT' in (r[2] or '').upper() or 'VARCHAR' in (r[2] or '').upper() or r[2] in ('text', 'varchar')]
    for col in cols:
        cname = col[1]
        try:
            n = con.execute(f"SELECT count(*) FROM {t} WHERE {cname} LIKE '%\ufffd%'").fetchone()[0]
            if n:
                print(f'{t}.{cname}: {n} rows with U+FFFD')
        except Exception:
            pass
con.close()