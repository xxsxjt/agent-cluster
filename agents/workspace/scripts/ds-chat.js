#!/usr/bin/env node
// ds-chat — DeepSeek proxy CLI, avoids shell encoding issues with Chinese
// Usage: node ds-chat.js "你好" --model deepseek-chat [--no-stream] [--reasoner|--vision]

const http = require('http');
const PROXY = 'http://localhost:3457/v1/chat/completions';
const KEY = 'sk-agnes-local-proxy-v1';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { model: 'deepseek-chat', stream: true, prompt: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') { opts.model = args[++i]; }
    else if (args[i] === '--reasoner') { opts.model = 'deepseek-reasoner'; }
    else if (args[i] === '--vision') { opts.model = 'deepseek-vision'; }
    else if (args[i] === '--no-stream' || args[i] === '-n') { opts.stream = false; }
    else if (!args[i].startsWith('-')) { opts.prompt = args[i]; }
  }
  return opts;
}

function chat(opts) {
  const data = JSON.stringify({
    model: opts.model,
    messages: [{ role: 'user', content: opts.prompt }],
    stream: opts.stream,
  });

  const req = http.request({
    hostname: 'localhost', port: 3457, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json; charset=utf-8' },
    timeout: 120000,
  }, res => {
    if (res.statusCode !== 200) {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        console.error(`❌ HTTP ${res.statusCode}: ${d.slice(0, 200)}`);
        process.exit(1);
      });
      return;
    }

    let buf = '';
    res.on('data', c => {
      if (opts.stream) {
        buf += c.toString();
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const l of lines) {
          if (l.startsWith('data: ') && l.slice(6) !== '[DONE]') {
            try {
              const d = JSON.parse(l.slice(6));
              const text = d.choices?.[0]?.delta?.content || '';
              if (text) process.stdout.write(text);
            } catch {}
          }
        }
      } else {
        buf += c.toString();
      }
    });
    res.on('end', () => {
      if (!opts.stream) {
        try {
          const j = JSON.parse(buf);
          console.log(j.choices?.[0]?.message?.content || '(empty)');
        } catch { console.error('Parse error:', buf.slice(0, 200)); }
      } else {
        process.stdout.write('\n');
      }
    });
  });

  req.on('error', e => { console.error('❌ Connection error:', e.message); process.exit(1); });
  req.on('timeout', () => { req.destroy(); console.error('⏱️ Timeout'); process.exit(1); });
  req.write(data);
  req.end();
}

const opts = parseArgs();
if (!opts.prompt) {
  console.log('Usage: node ds-chat.js <prompt> [options]');
  console.log('  --model, -m <name>   Model: deepseek-chat (default), deepseek-reasoner, deepseek-vision');
  console.log('  --reasoner            Shortcut for --model deepseek-reasoner');
  console.log('  --vision              Shortcut for --model deepseek-vision');
  console.log('  --no-stream, -n       Non-streaming output');
  console.log('');
  console.log('Examples:');
  console.log('  node ds-chat.js "用一句话介绍人工智能"');
  console.log('  node ds-chat.js "1+1等于几" --reasoner');
  console.log('  node ds-chat.js "你好" -n');
  process.exit(0);
}
chat(opts);
