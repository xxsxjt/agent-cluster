# -*- coding: utf-8 -*-
import os, sys, json
sys.stdout.reconfigure(encoding='utf-8')
f = r'C:\Users\du_ji\pi_workspace\org\logs\nextday-2026-08-11-360-升级提醒配置提权落盘收尾-152618-improve.log'
with open(f, encoding='utf-8', errors='replace') as fh:
    lines = fh.readlines()
print('total lines', len(lines))
n_text = 0
for i, l in enumerate(lines):
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get('type') == 'message_end':
        msg = o.get('message', {})
        if msg.get('role') == 'assistant':
            for c in msg.get('content', []):
                if c.get('type') == 'text':
                    n_text += 1
                    print(f'[TXT#{n_text}]', c.get('text', '')[:2500])
                    print('---')
