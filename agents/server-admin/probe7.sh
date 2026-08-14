set -u
echo "=== top memory consumers (RSS MiB) ==="
ps -eo rss,comm,args --sort=-rss | head -14 | awk '{printf "%8.0f  %s\n", $1/1024, substr($0, index($0,$2))}' | cut -c1-110
echo
echo "=== free ==="
free -m
echo
echo "=== firewalld ==="
firewall-cmd --state 2>&1
firewall-cmd --list-ports 2>&1
echo "zone: $(firewall-cmd --get-default-zone 2>&1)"
echo
echo "=== does -seed exist in OTAPI.dll? ==="
python3 - <<'PY'
import re
b=open('/data/terraria/tshock/bin/OTAPI.dll','rb').read()
for s in ['-seed','seed','autocreate','worldevil','SeedText','SetSeed','8400','GetFullSeedText','UseSeed']:
    u=s.encode('utf-16-le')
    print("%-16s utf16=%d  utf8=%d" % (s, b.count(u), b.count(s.encode())))
PY
echo
echo "=== autocreate size mapping strings ==="
python3 - <<'PY'
b=open('/data/terraria/tshock/bin/TerrariaServer.dll','rb').read()
for s in ['autocreate','Invalid world size','small','medium','large']:
    print("%-22s utf16=%d" % (s, b.count(s.encode('utf-16-le'))))
PY
echo
echo "=== baseline: current live world header (control, plain numeric seed) ==="
python3 /data/terraria/ops/wldcheck.py /data/terraria/worlds/HKWorld.wld
echo "=== python3 version ==="
python3 -V
