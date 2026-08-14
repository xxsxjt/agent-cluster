#!/usr/bin/env node
// WCAG 2.x 对比度计算：验证 style.css 文字/背景配对
'use strict';
function hex(c){c=c.replace('#','');if(c.length===3)c=c.split('').map(x=>x+x).join('');return [parseInt(c.slice(0,2),16),parseInt(c.slice(2,4),16),parseInt(c.slice(4,6),16)];}
function lin(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}
function lum(c){const [r,g,b]=hex(c);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);}
function ratio(a,b){const l1=lum(a),l2=lum(b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05);}
const PASS_N=4.5, PASS_L=3.0; // 正文/大字号
function rep(fg,bg,label){const r=ratio(fg,bg);const okN=r>=PASS_N, okL=r>=PASS_L;
  const tag= okN?'AA正文':(okL?'仅大字':'FAIL');
  console.log(`${(okN?'✓':(okL?'△':'✗'))} ${label.padEnd(30)} ${fg} on ${bg} = ${r.toFixed(2)}:1  [${tag}]`);
  return r;}
// 背景
const BG='#0e1116',BG2='#151a21',BG3='#1b222b',BG4='#212a35',SEL='#1f3f6b';
console.log('=== 灰阶文字 vs 主背景/卡片背景 ===');
for(const [fg,n] of [['#dbe3ec','--fg'],['#8b98a9','--fg2'],['#5d6a7a','--fg3']]){
  rep(fg,BG,n+' on bg');rep(fg,BG2,n+' on bg2');rep(fg,BG3,n+' on bg3');
}
console.log('=== 状态色 ===');
rep('#3fb950',BG2,'--ok(active) on bg2');
rep('#58a6ff',BG2,'--run on bg2');
rep('#d29922',BG2,'--warn on bg2');
rep('#f85149',BG2,'--err on bg2');
rep('#4da3ff',BG2,'--acc on bg2');
console.log('=== sleeping/retired 点 & 字 ===');
rep('#8b98a9',BG,'sleeping chip(fg2) on bg');
rep('#5d6a7a',BG,'sleeping chip(fg3) on bg');
console.log('=== 事件流正文 ===');
rep('#e6edf5','#12212f','k-text evb on #12212f');
rep('#8b98a9',BG2,'evb(fg2) on bg2');
rep('#dbe3ec',BG2,'k-final evb? on bg2');
console.log('=== 候选新值试算 ===');
for(const fg of ['#e9eef6','#b3becb','#93a1b1','#8fa0b3','#a8b4c2']){
  rep(fg,BG,'cand '+fg+' on bg');rep(fg,BG3,'cand '+fg+' on bg3');
}
