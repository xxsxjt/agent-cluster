set -u
echo "=== DO-NOT-TOUCH-WORLD2.txt ==="
cat /data/terraria/ops/DO-NOT-TOUCH-WORLD2.txt
echo "=== steps-w2.json ==="
cat /data/terraria/ops/steps-w2.json
echo
echo "=== gen-w2d.log tail (concurrent gen) ==="
tail -c 2000 /data/terraria/ops/gen-w2d.log | tr -d '\000'
echo
echo "=== gen-w2d.log: key lines ==="
grep -aoE "Creating world[^\r\n]{0,160}|世界名[^\r\n]{0,60}|Seed:[^\r\n]{0,60}|种子[^\r\n]{0,80}" /data/terraria/ops/gen-w2d.log | tail -20
echo "=== which world file is the concurrent gen writing? (lsof-ish) ==="
ls -l /proc/1328674/cwd 2>/dev/null
for p in $(pgrep -f 'w2gen.bin' 2>/dev/null); do echo "--- pid $p"; tr '\0' ' ' < /proc/$p/cmdline; echo; ls -l /proc/$p/fd 2>/dev/null | grep -i 'wld\|worlds' ; done
echo "=== tshock2gen dir ==="
ls -la /data/terraria/tshock/tshock2gen/ 2>/dev/null
echo "=== finalize-w2.sh ==="
cat /data/terraria/ops/finalize-w2.sh
