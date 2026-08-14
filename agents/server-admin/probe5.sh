set -u
B=/data/terraria/tshock/bin
echo "=== Terraria version in OTAPI ==="
strings -el "$B/OTAPI.dll" | grep -aE '^1\.4\.[0-9]+(\.[0-9]+)?$' | sort -u | head
echo
echo "=== seed modifier names in OTAPI.dll (utf16) ==="
for s in "abandoned manors" "arachnophobia" "planetoids" "water park" "not the bees" "get fixed boi" "for the worthy" "rainbow road" "toadstool" "monochrome" "no traps" "more traps please" "x-ray vision" "truck stop" "mole people" "hocus pocus"; do
  n=$(strings -el "$B/OTAPI.dll" | grep -Fic -- "$s")
  m=$(strings -a  "$B/OTAPI.dll" | grep -Fic -- "$s")
  echo "  [$s] utf16=$n utf8=$m"
done
echo
echo "=== known 1.4.4 secret seed literals (utf16) ==="
strings -el "$B/OTAPI.dll" | grep -aiE '^(not the bees|for the worthy|celebrationmk10|the constant|no traps|drunk world|get fixed boi|05162020|5162020|constant)$' | sort -u
echo
echo "=== anything looking like a seed-flag list / pipe format ==="
strings -el "$B/OTAPI.dll" | grep -aE '\|' | grep -aiE 'seed|world' | head -20
echo
echo "=== WorldGen 'remix|drunk|notthebees|getGoodWorld|tenthAnniversary' identifiers ==="
strings -el "$B/OTAPI.dll" | grep -aoE '(drunkWorld|getGoodWorld|tenthAnniversaryWorld|dontStarveWorld|notTheBeesWorld|remixWorld|noTrapsWorld|zenithWorld|everythingWorld)' | sort | uniq -c
echo
echo "=== TShock CLI args (TShockAPI.dll + TerrariaServer.dll, utf16) ==="
for f in "$B/TerrariaServer.dll" /data/terraria/tshock/ServerPlugins/TShockAPI.dll; do
  echo "--- $f ---"
  strings -el "$f" | grep -aoE '^-[a-z][a-z0-9-]{2,24}$' | sort -u | tr '\n' ' '
  echo
done
echo
echo "=== configpath / worldpath / logpath style args ==="
for f in "$B/TerrariaServer.dll" /data/terraria/tshock/ServerPlugins/TShockAPI.dll; do
  echo "--- $f ---"
  strings -el "$f" | grep -aiE '^-(config|world|log|port|players|pass|seed|autocreate|difficulty|worldevil|worldname|maxplayers|secure|lang|ip|dump|additionalplugins|savedirectory|crashdir)' | sort -u | tr '\n' ' '
  echo
done
