set -u
echo "=== terraria user ==="
getent passwd terraria
echo "=== bundle extract dirs ==="
find /data/terraria/.net -maxdepth 3 -type d 2>/dev/null | head -20
echo "--- dll list (if extracted) ---"
find /data/terraria/.net -name 'TShockAPI.dll' -o -name 'TerrariaServer.dll' 2>/dev/null | head
echo "=== CLI args (utf16 strings from TShock.Server) ==="
strings -el /data/terraria/tshock/TShock.Server | grep -E '^-[a-z]' | sort -u | head -60
echo "=== seed modifier names present in binary? (utf16) ==="
for w in "abandoned manors" "arachnophobia" "planetoids" "water park" "not the bees" "get fixed boi" "for the worthy" "rainbow road" "we don't even test for that" "toadstool"; do
  n=$(strings -el /data/terraria/tshock/TShock.Server | grep -c -i -F "$w")
  n8=$(strings -a /data/terraria/tshock/TShock.Server | grep -c -i -F "$w")
  echo "  [$w] utf16=$n utf8=$n8"
done
echo "=== version string ==="
strings -el /data/terraria/tshock/TShock.Server | grep -E '^1\.4\.[0-9]+(\.[0-9]+)?$' | sort -u | head
