set -u
echo "=== 1. services ==="
systemctl is-active terraria terraria2 2>&1
systemctl show -p ExecStart --value terraria2 2>&1
systemctl show -p ExecStart --value terraria 2>&1
echo
echo "=== 2. TShock processes (orphan check) ==="
ps -eo pid,ppid,lstart,rss,args | grep -i '[T]Shock.Server' || echo "none"
echo
echo "=== 3. other suspicious helper procs ==="
ps -eo pid,lstart,args | grep -E '[t]sdrive|[g]enworld' || echo "none"
echo
echo "=== 4. worlds dir ==="
ls -la /data/terraria/worlds/ 2>&1
echo
echo "=== 5. ports ==="
ss -lntp 2>/dev/null | grep -E '7777|8888|8889' || echo "no listeners"
echo
echo "=== 6. tshock dir / version ==="
ls -la /data/terraria/tshock/ | head -40
echo "--- ops ---"
ls -la /data/terraria/ops/ 2>&1
echo
echo "=== 7. dotnet ==="
dotnet --list-runtimes 2>&1 | head
which ilspycmd monodis ikdasm 2>&1 | head
