#!/usr/bin/env node
// WCAG 对比度复验：style.css 修改后
'use strict';
function hex(c){c=c.replace('#','');if(c.length===3)c=c.split('').map(x=>x+x).join('');return [parseInt(c.slice(0,2),16),parseInt(c.slice(2,4),16),parseInt(c.slice(4,6),16)];}
function lin(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}
function lum(c){const [r,g,b]=hex(c);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);}
function ratio(a,b){const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);}
const BG='#0e1116',BG2='#151a21',BG3='#1b222b',BG4='#212a35',SEL='#1f3f6b',TXTBG='#12212f',FINBG='#142a1c',ERRBG='#2a1518';
let fail=0,warn=0;
function rep(fg,bg,label,isLarge){const r=ratio(fg,bg);
  const need=isLarge?3.0:4.5;const ok=r>=need;
  if(!ok){ if(r>=3.0){warn++;} else {fail++;} }
  console.log(`${ok?'✓':(r>=3.0?'△':'✗')} ${label.padEnd(34)} ${fg} on ${bg} = ${r.toFixed(2)}:1 ${isLarge?'[大字3.0]':'[AA4.5]'}`);
}
console.log('=== 新灰阶（fg/fg2/fg3）===');
for(const [fg,n] of [['#e9eef6','--fg(正文)'],['#b6c1cd','--fg2(次要)'],['#91a0b0','--fg3(三级)']]){
  rep(fg,BG,n+' on 主背景');rep(fg,BG2,n+' on 卡片bg2');rep(fg,BG3,n+' on bg3');rep(fg,BG4,n+' on bg4');
}
console.log('=== 地板要求核对（十六进制亮度）===');
const L_e0=lum('#e0e0e0'),L_a0=lum('#a0a0a0');
console.log(`  --fg  #e9eef6 lum=${lum('#e9eef6').toFixed(3)}  >= #e0e0e0 lum=${L_e0.toFixed(3)} ? ${lum('#e9eef6')>=L_e0}`);
console.log(`  --fg2 #b6c1cd lum=${lum('#b6c1cd').toFixed(3)}  >= #a0a0a0 lum=${L_a0.toFixed(3)} ? ${lum('#b6c1cd')>=L_a0}`);
console.log('=== 状态色（active/sleeping/run/warn/err/acc）===');
rep('#3fb950',BG2,'active/ok on bg2');
rep('#3fb950',FINBG,'final tag on #142a1c');
rep('#58a6ff',BG2,'run on bg2');
rep('#d29922',BG2,'warn/tool on bg2');
rep('#d29922',BG3,'tool tag on bg3(evh)');
rep('#f85149',BG2,'err on bg2');
rep('#f85149',ERRBG,'err tag on #2a1518');
rep('#4da3ff',BG2,'acc on bg2');
rep('#7d8a9c',BG2,'sleeping点(非文字3:1) on bg2',true);
rep('#6b7684',BG2,'retired点(非文字3:1) on bg2',true);
rep('#b3908f',BG2,'d-retired点(非文字3:1) on bg2',true);
rep('#91a0b0',BG,'sleeping chip字(fg3) on bg');
console.log('=== 选中行/标题/特殊底 ===');
rep('#e9eef6',SEL,'row.on lab on --sel');
rep('#eaf2ff',SEL,'row.on lab #eaf2ff on sel');
rep('#e6edf5',TXTBG,'k-text evb on #12212f');
rep('#b6c1cd',BG2,'普通evb(fg2) on bg2');
console.log('=== 其它浅色标签 ===');
rep('#7f8896',BG2,'k-result tag on bg2');
rep('#6bb5a0',BG2,'k-user tag on bg2');
rep('#91a0b0',BG2,'k-system tag(fg3) on bg2');
rep('#9d7bd8',BG2,'k-thinking tag on bg2');
rep('#ffb4ae','#3d1d1d','banner err文字');
rep('#ffdc9e','#3a2f14','banner warn文字');
console.log(`\n结果: fail=${fail} warn(仅大字)=${warn}`);
