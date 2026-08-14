set -u
echo "=== extraction dir contents ==="
ls -la /data/terraria/.net/TShock.Server/y2uZm7A5zAUP 2>&1 | head -40
echo "--- find dlls anywhere under .net ---"
find /data/terraria/.net -name '*.dll' 2>/dev/null | head -30
echo "--- count ---"
find /data/terraria/.net -type f 2>/dev/null | wc -l
echo
echo "=== tshock/bin contents ==="
ls -la /data/terraria/tshock/bin 2>&1 | head -40
echo
echo "=== ServerPlugins ==="
ls -la /data/terraria/tshock/ServerPlugins 2>&1 | head -20
echo
echo "=== ServerLog head: version banner ==="
grep -aiE "TShock|Terraria|版本|version" /data/terraria/tshock/ServerLog.txt | head -20
echo
echo "=== tshock/logs latest file, first 40 lines ==="
LATEST=$(ls -t /data/terraria/tshock/tshock/logs/*.log 2>/dev/null | head -1)
echo "latest=$LATEST"
head -40 "$LATEST" 2>/dev/null
