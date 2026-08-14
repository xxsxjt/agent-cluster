set -u
echo "=== 1) terraria.service (DO NOT TOUCH) ==="
systemctl is-active terraria; systemctl is-enabled terraria
cat /etc/systemd/system/terraria.service
echo
echo "=== 2) existing terraria2 traces? ==="
ls -la /etc/systemd/system/ | grep -i terraria || echo "(only terraria.service)"
echo
echo "=== 3) processes ==="
ps -o pid,lstart,args -C TShock.Server 2>/dev/null || echo "(ps -C empty)"
echo "--- pgrep count ---"
pgrep -fc '[T]Shock.Server' || true
echo
echo "=== 4) ports ==="
ss -lntp | head -30
echo
echo "=== 5) worlds dir ==="
ls -la /data/terraria/worlds/
echo
echo "=== 6) tshock tree (depth 2) ==="
ls -la /data/terraria/
echo "--- tshock/ ---"
ls -la /data/terraria/tshock/ | head -40
echo "--- tshock/tshock/ ---"
ls -la /data/terraria/tshock/tshock/ | head -40
echo
echo "=== 7) ops scripts ==="
ls -la /data/terraria/ops/ 2>/dev/null
echo
echo "=== 8) disk / mem ==="
df -h /data /
free -m
