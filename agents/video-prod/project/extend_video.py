#!/usr/bin/env python3
import argparse, subprocess, sys, os, json, tempfile, shutil

def check_ffmpeg():
    try:
        r = subprocess.run(['ffmpeg','-version'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            print('OK ' + r.stdout.splitlines()[0].strip())
            return True
    except: pass
    print('FAIL: ffmpeg not found')
    return False

def get_video_info(vp):
    r = subprocess.run(['ffprobe','-v','quiet','-print_format','json','-show_streams','-show_format',vp], capture_output=True, text=True)
    if r.returncode != 0: return None
    info = json.loads(r.stdout)
    vs = None
    for s in info.get('streams',[]):
        if s.get('codec_type')=='video': vs=s; break
    if not vs: return None
    w=int(vs.get('width',0)); h=int(vs.get('height',0))
    rfr=vs.get('r_frame_rate','24/1')
    if '/' in rfr:
        n,d=rfr.split('/'); fps=float(n)/float(d) if float(d)>0 else 24
    else: fps=float(rfr)
    dur=float(info.get('format',{}).get('duration',0))
    codec=vs.get('codec_name','h264')
    return dict(width=w,height=h,fps=round(fps,2),duration=dur,codec=codec)

def extract_tail(vp, outp=None, ln=1):
    info=get_video_info(vp)
    if not info: return None,None
    d=info['duration']; st=max(0,d-ln)
    op=outp or vp.rsplit('.',1)[0]+'_tail.png'
    r=subprocess.run(['ffmpeg','-y','-ss',str(st),'-i',vp,'-vframes','1','-q:v','2','-update','1',op],capture_output=True,text=True)
    if r.returncode!=0: return None,None
    return op,info

def extend_single(vp, seconds=5, output=None, fadeout=0):
    info=get_video_info(vp)
    if not info: return None
    tf=tempfile.NamedTemporaryFile(suffix='_tail.png',delete=False); tp=tf.name; tf.close()
    _,info=extract_tail(vp,tp)
    if not info: return None
    if not output: output=os.path.splitext(vp)[0]+'_extended_'+str(seconds)+'s.mp4'
    fc='[1:v]loop=1:size=1:[1v_loop];[0:v][1v_loop]concat=n=2:v=1:a=0[outv]'
    if fadeout>0 and fadeout<=seconds:
        fs=seconds-fadeout
        fc='[1:v]fade=t=out:st='+str(fs)+':d='+str(fadeout)+';[1:v]loop=1:size=1:[1v_loop];[0:v][1v_loop]concat=n=2:v=1:a=0[outv]'
    r=subprocess.run(['ffmpeg','-y','-i',vp,'-loop','1','-t',str(seconds),'-i',tp,'-filter_complex',fc,'-map','[outv]','-c:v',info['codec'],'-pix_fmt','yuv420p',output],capture_output=True,text=True)
    os.unlink(tp)
    if r.returncode!=0: return None
    ni=get_video_info(output)
    if ni:
        od=info['duration']; nd=ni['duration']
        print('OK: '+str(round(od,1))+'s -> '+str(round(nd,1))+'s (+'+str(round(nd-od,1))+'s)')
        print('  Output: '+output)
    return output

def infinite_extend(vp, ts=300, cs=60, output=None):
    cur=vp; ci=get_video_info(cur)
    if not ci: return None
    cd=ci['duration']
    print('Start: '+os.path.basename(cur)+' ('+str(round(cd,1))+'s)')
    print('Target: '+str(ts)+'s, Chunk: '+str(cs)+'s')
    it=0
    while cd<ts:
        rem=ts-cd; ch=min(cs,rem); it+=1
        print('[Iter '+str(it)+'] Extending by '+str(int(ch))+'s...')
        out=output if output and it==1 else os.path.splitext(cur)[0]+'_ext'+str(it)+'.mp4'
        res=extend_single(cur,seconds=ch,output=out)
        if not res: return None
        cur=res; ci=get_video_info(cur); cd=ci['duration']
        print('  Now: '+str(round(cd,1))+'s / '+str(ts)+'s')
    if output and output!=cur: shutil.copy2(cur,output); cur=output
    print('DONE: '+os.path.basename(cur)+' = '+str(round(cd,1))+'s (target '+str(ts)+'s)')
    return cur

def main():
    p=argparse.ArgumentParser(description='无限取尾帧延长视频工具')
    sp=p.add_subparsers(dest='command',help='操作类型')
    ep=sp.add_parser('extend',help='延长单个视频')
    ep.add_argument('video'); ep.add_argument('--seconds','-t',type=int,default=5)
    ep.add_argument('--output','-o'); ep.add_argument('--fadeout',type=float,default=0)
    cp=sp.add_parser('chain',help='链式拼接')
    cp.add_argument('videos',nargs='+'); cp.add_argument('--output','-o')
    cp.add_argument('--extra-seconds','-e',type=int,default=0)
    xp=sp.add_parser('extract',help='提取尾帧图片')
    xp.add_argument('video'); xp.add_argument('--output','-o')
    xp.add_argument('--last-seconds','-n',type=int,default=1)
    ip=sp.add_parser('inf',help='无限延长到指定时长')
    ip.add_argument('video'); ip.add_argument('--target','-T',type=float,required=True)
    ip.add_argument('--chunk','-c',type=int,default=60); ip.add_argument('--output','-o')
    a=p.parse_args()
    if not a.command: p.print_help(); return
    if not check_ffmpeg(): sys.exit(1)
    if a.command=='extend':
        if not os.path.isfile(a.video): print('Not found: '+a.video); sys.exit(1)
        r=extend_single(a.video,seconds=a.seconds,output=a.output,fadeout=a.fadeout)
        sys.exit(0 if r else 1)
    elif a.command=='inf':
        if not os.path.isfile(a.video): print('Not found: '+a.video); sys.exit(1)
        r=infinite_extend(a.video,ts=a.target,cs=a.chunk,output=a.output)
        sys.exit(0 if r else 1)
    elif a.command=='chain':
        miss=[v for v in a.videos if not os.path.isfile(v)]
        if miss: print('Not found: '+str(miss)); sys.exit(1)
        if len(a.videos)<2: print('Need 2+ videos'); sys.exit(1)
        print('Chain extend: '+str(len(a.videos))+' videos')
        tils=[]
        for i,vp in enumerate(a.videos):
            print('['+str(i+1)+'/'+str(len(a.videos))+'] Tail: '+os.path.basename(vp))
            tp,_=extract_tail(vp,ln=1); tils.append(tp)
        exp=[]
        for i,vp in enumerate(a.videos):
            if a.extra_seconds>0:
                eo=os.path.splitext(vp)[0]+'_ext.mp4'
                print('Append tail (+'+str(a.extra_seconds)+'s) to: '+os.path.basename(vp))
                ex=extend_single(vp,seconds=a.extra_seconds,output=eo)
                exp.append(ex or vp)
            else: exp.append(vp)
        out=a.output if a.output else os.path.splitext(a.videos[0])[0]+'_chain.mp4'
        ifs=[]; fps=[]; concat_labels=[]; gi=0
        for i in range(len(exp)):
            ifs.append(exp[i]); concat_labels.append('['+str(gi)+':v]'); gi+=1
            if i<len(exp)-1 and tils[i]:
                tr='_trans_'+str(gi)+'.png'; shutil.copy2(tils[i],tr); ifs.append(tr)
                fi='['+str(gi)+':v]fade=t=in:st=0:d=0.5,fade=t=out:st=0.5:d=0.5[tr'+str(i)+']'
                fps.append(fi); concat_labels.append('[tr'+str(i)+']'); gi+=1
        n=len(ifs); ci=''.join(concat_labels)
        cf=ci+'concat=n='+str(n)+':v=1:a=0[outv]'
        af=';'.join(fps)+((';' + cf) if fps else cf)
        cmd=['ffmpeg','-y']
        for f in ifs: cmd.extend(['-i',f])
        cmd.extend(['-filter_complex',af,'-map','[outv]','-c:v','libx264','-pix_fmt','yuv420p','-preset','fast',out])
        print('Assembling '+str(n)+' segments...')
        r=subprocess.run(cmd,capture_output=True,text=True)
        for i in range(len(exp)-1):
            tr='_trans_'+str(i)+'.png'
            if os.path.exists(tr): os.unlink(tr)
        if r.returncode!=0: print('FAIL: '+r.stderr[:300]); return None
        fi2=get_video_info(out)
        if fi2:
            to=sum(get_video_info(v)['duration'] for v in exp if get_video_info(v))
            print('Chain complete! '+str(round(to,1))+'s -> '+str(round(fi2['duration'],1))+'s')
            print('  Output: '+out)
        return out
    elif a.command=='extract':
        if not os.path.isfile(a.video): print('Not found: '+a.video); sys.exit(1)
        tp,_=extract_tail(a.video,output_path=a.output,ln=a.last_seconds)
        sys.exit(0 if tp else 1)

if __name__=='__main__': main()
