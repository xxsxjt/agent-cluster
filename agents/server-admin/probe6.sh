set -u
D=/data/terraria/tshock/bin/OTAPI.dll
u16() { python3 -c "import sys;sys.stdout.buffer.write(sys.argv[1].encode('utf-16-le'))" "$1"; }

echo "=== sanity: grep utf16 for strings that MUST exist ==="
for s in "Corruption" "Crimson" "Expert" "Journey" "worldevil" "Creating world"; do
  n=$(u16 "$s" | grep -acF -f /dev/stdin "$D" 2>/dev/null || echo 0)
  printf "  [%s] utf16-lines=%s\n" "$s" "$n"
done

echo "=== better method: python scan of raw bytes for utf16-le occurrences ==="
python3 - "$D" <<'PY'
import sys
p=sys.argv[1]
b=open(p,'rb').read()
print("size",len(b))
names=["abandoned manors","arachnophobia","beam me up","bring a towel","planetoids",
       "not the bees","for the worthy","get fixed boi","celebrationmk10","drunk world",
       "rainbow road","toadstool","monochrome","no traps","more traps please",
       "x-ray vision","truck stop","mole people","hocus pocus","water park",
       "i am error","invisible plane","jagged rocks","jingle all the way",
       "night of the living dead","pumpkin season","purify this","royale with cheese",
       "too easy","winter is coming","sandy britches","such great heights",
       "we don't even test for that","does that sparkle","fish mox",
       "how did i get here","negative infinity","double daring dangers",
       "save the rainforest","the care bears movie",
       "what a horrible night to have a curse"]
for n in names:
    u16=b.count(n.encode('utf-16-le'))
    u16c=b.count(n.title().encode('utf-16-le'))
    u8=b.count(n.encode())
    if u16 or u8 or u16c:
        print("HIT  %-42s utf16=%d utf16title=%d utf8=%d"%(n,u16,u16c,u8))
    else:
        print("miss %-42s"%n)
PY

echo "=== search for the version-prefix / pipe seed format markers ==="
python3 - "$D" <<'PY'
import sys,re
b=open(sys.argv[1],'rb').read()
for pat in ["1.1.1.0","{0}.{1}.{2}.{3}.","|","seedFlags","WorldSeedFlags","SeedFlag","secretSeed","SecretSeed"]:
    u=b.count(pat.encode('utf-16-le'))
    print("%-22s utf16=%d"%(pat,u))
# find utf16 strings containing '|' that look like seed lists
txt=b.decode('utf-16-le','ignore')
cands=set(re.findall(r'[A-Za-z0-9 .\-]{0,30}\|[A-Za-z0-9 .\-|]{5,120}',txt))
print("--- utf16 strings containing pipes (first 25) ---")
for c in sorted(cands)[:25]: print(repr(c[:140]))
PY
