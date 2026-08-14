# -*- coding: utf-8 -*-
import os, sys, glob
sys.stdout.reconfigure(encoding='utf-8')
inbox = r'C:\Users\du_ji\pi_workspace\org\inbox'
# find files matching the 360 task
for f in os.listdir(inbox):
    if '152618' in f and '360' in f:
        p = os.path.join(inbox, f)
        print('=====', f, '=====')
        try:
            print(open(p, encoding='utf-8').read())
        except Exception as e:
            print('ERR', e)
        print()
