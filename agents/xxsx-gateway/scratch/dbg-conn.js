const net = require('net');
const full = '\\\\.\\pipe\\codex-browser-use\\0506593a-521b-442b-b651-4717db95b992';
console.log('connecting to', full);
const s = net.createConnection(full, () => { console.log('CONNECTED'); s.end(); });
s.on('error', e => console.log('ERR', e.message));
s.on('close', () => console.log('CLOSED'));