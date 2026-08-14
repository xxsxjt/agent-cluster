// dbg-pipes.js — debug pipe enumeration & connection
const { spawnSync } = require('child_process');
const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem "\\\\.\\pipe\\" | Where-Object {$_.Name -like "codex-browser-use*"} | Select-Object -ExpandProperty Name';
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log('stdout:', JSON.stringify(r.stdout));
console.log('stderr:', JSON.stringify(r.stderr));
console.log('status:', r.status);