# -*- coding: utf-8 -*-
import os, sys
sys.stdout.reconfigure(encoding='utf-8')
p = r'C:\Users\du_ji\pi_workspace\org\inbox\nextday-2026-08-11-360-升级提醒配置提权落盘收尾-152618.DONE'
data = open(p, 'rb').read()
print('raw bytes:', data)
for enc in ['gbk','utf-8','latin-1']:
    try:
        print(f'--- {enc} ---')
        print(data.decode(enc))
    except Exception as e:
        print(enc, 'fail', e)
