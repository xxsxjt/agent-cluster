#!/bin/bash
# Finalize world 2: install the staged world, fix instance-2 config, start service.
# Safe to re-run. Never touches terraria.service / HKWorld.wld.
set -u
STAGE=/data/terraria/.local/share/Terraria/Worlds/HKWorld2.wld
DEST=/data/terraria/worlds/HKWorld2.wld
CFG=/data/terraria/tshock/tshock2/config.json

echo "===== 1. staged world present? ====="
ls -l "$STAGE" || { echo "FATAL: no staged world"; exit 1; }

echo "===== 2. verify staged world BEFORE installing ====="
python3 /data/terraria/ops/wldcheck.py "$STAGE"

echo "===== 3. zero-concurrency check (pitfall guard) ====="
n=$(pgrep -c -f '[T]Shock.Server' || true)
echo "TShock proc count: $n"
ps -eo pid,args --no-headers | grep -a '[T]Shock.Server' | cut -c1-100
if pgrep -f '[T]Shock.Server' | xargs -r ps -o args= -p 2>/dev/null | grep -aq 'HKWorld2'; then
  echo "FATAL: something already holds HKWorld2 - abort"; exit 1
fi

echo "===== 4. install world ====="
install -o terraria -g terraria -m 644 "$STAGE" "$DEST"
ls -l "$DEST"

echo "===== 5. fix instance-2 config (port/slots/logpath) ====="
python3 - <<'PY'
import json
p = '/data/terraria/tshock/tshock2/config.json'
d = json.load(open(p, encoding='utf-8'))
s = d['Settings']
want = {'ServerPort': 8888, 'MaxSlots': 6, 'ServerName': 'HKWorld2',
        'LogPath': 'tshock2/logs', 'ServerPassword': '2287',
        'DisableLoginBeforeJoin': True, 'RequireLogin': False}
for k, v in want.items():
    old = s.get(k)
    s[k] = v
    print('  %-24s %r -> %r' % (k, old, v))
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
PY
chown terraria:terraria "$CFG"

echo "===== 6. groups: instance2 vs instance1 ====="
for db in /data/terraria/tshock/tshock/tshock.sqlite /data/terraria/tshock/tshock2/tshock.sqlite; do
  echo "--- $db"
  sqlite3 "$db" "SELECT GroupName FROM GroupList ORDER BY GroupName;" 2>&1 | tr '\n' ' '; echo
done
echo "--- default group permissions differ? ---"
diff <(sqlite3 /data/terraria/tshock/tshock/tshock.sqlite "SELECT GroupName,Commands,Parent FROM GroupList ORDER BY GroupName;") \
     <(sqlite3 /data/terraria/tshock/tshock2/tshock.sqlite "SELECT GroupName,Commands,Parent FROM GroupList ORDER BY GroupName;") \
  && echo "IDENTICAL group table"

echo "===== 7. start terraria2 ====="
systemctl reset-failed terraria2 2>/dev/null || true
systemctl daemon-reload
systemctl enable terraria2 >/dev/null 2>&1
systemctl start terraria2
sleep 25
systemctl show terraria2 -p ActiveState -p SubState -p NRestarts -p ExecMainPID

echo "===== 8. verify ====="
ss -lntp | grep -E ':(7777|8888)' || echo "NO LISTENER"
echo "--- world1 must be untouched ---"
systemctl show terraria -p ActiveState -p NRestarts -p ExecMainPID
md5sum /data/terraria/tshock/tshock/config.json
echo "expect 9fc8e2233835b3a48750ac01379fb4f0"
echo "--- what seed is instance 2 actually serving? ---"
python3 /data/terraria/ops/wldcheck.py "$DEST"
