# -*- coding: utf-8 -*-
import os, sys
sys.stdout.reconfigure(encoding='utf-8')
d = r'C:\Program Files (x86)\360\360Safe\SoftMgr'
for n in ['softmgrcfg.ini','roconfig.ini','Config.ini','SoftExamConfig.xml','SoftExamConfig_New.xml','SoftExamConfig_UpdateSoft.xml']:
    p = os.path.join(d, n)
    print('==========', n, '==========')
    if not os.path.exists(p):
        print('  NOT FOUND'); continue
    b = open(p,'rb').read()
    print('  size:', len(b), 'mtime:', os.path.getmtime(p))
    for enc in ['gbk','utf-8','latin-1']:
        try:
            txt = b.decode(enc)
            print(f'  --- {enc} ---')
            print(txt)
            break
        except Exception as e:
            pass
    print()
