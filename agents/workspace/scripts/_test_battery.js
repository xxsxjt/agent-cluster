const http = require('http');
const tests = [
  { name: '简单问候', model: 'deepseek-chat', msg: '你好，用一句话自我介绍' },
  { name: '数学计算', model: 'deepseek-chat', msg: '123 * 456 = ?' },
  { name: '代码生成', model: 'deepseek-chat', msg: '写一个Python函数判断素数' },
  { name: '专家模式', model: 'deepseek-reasoner', msg: '如果3个人3天喝3桶水，9个人9天喝几桶水？' },
];

async function runTest(t) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      model: t.model,
      messages: [{ role: 'user', content: t.msg }],
      stream: false,
    });
    const start = Date.now();
    const req = http.request({
      hostname: 'localhost', port: 3457, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': 'Bearer sk-agnes-local-proxy-v1',
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const ms = Date.now() - start;
        try {
          const j = JSON.parse(d);
          const content = j.choices?.[0]?.message?.content || '';
          const ok = content.length > 2;
          console.log(`[${ok ? '✅' : '❌'}] ${t.name} (${t.model}) — ${ms}ms, ${content.length} chars`);
          console.log(`   → ${content.slice(0, 120).replace(/\n/g, ' ')}${content.length > 120 ? '...' : ''}`);
          resolve({ ok, name: t.name, content, ms });
        } catch {
          console.log(`[❌] ${t.name} (${t.model}) — parse error: ${d.slice(0, 100)}`);
          resolve({ ok: false, name: t.name, error: d.slice(0, 100), ms });
        }
      });
    });
    req.on('error', e => {
      console.log(`[❌] ${t.name} — connection error: ${e.message}`);
      resolve({ ok: false, name: t.name, error: e.message, ms: Date.now() - start });
    });
    req.on('timeout', () => {
      req.destroy();
      console.log(`[⏱️] ${t.name} — timeout`);
      resolve({ ok: false, name: t.name, error: 'timeout', ms: Date.now() - start });
    });
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== DeepSeek 测试 ===\n');
  let ok = 0, fail = 0;
  for (const t of tests) {
    const r = await runTest(t);
    if (r.ok) ok++; else fail++;
    console.log('');
  }
  console.log(`=== 结果: ${ok} ✅ / ${fail} ❌ ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
