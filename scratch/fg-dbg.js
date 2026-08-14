const fg = require("C:/Users/du_ji/pi_workspace/org/lib/fullscan-guard");
const bs = String.fromCharCode(92); // backslash
const cases = [
  '"C:' + bs + 'Program Files' + bs + 'Git' + bs + 'usr' + bs + 'bin' + bs + 'find.exe" / -name tailscaled.log',
  'find / -name x',
  'find C:/ -name x',
  'find C:' + bs + ' -name x',
  'grep -r foo /',
  'grep -r / pattern',
  'grep -r foo C:/',
];
for (const c of cases) {
  const cl = fg.classify(c);
  console.log(JSON.stringify({ fullDisk: cl.fullDisk, roots: cl.roots }) + '  <=  ' + c);
}
