import json, sys
prefix, size, diff, evil, name, listfile, out = sys.argv[1:8]
seed = open(listfile, encoding="utf-8").read().strip()
full = seed if prefix == "NONE" else prefix + seed
steps = [["Choose World", "n"], ["Choose size", size],
         ["Choose difficulty", diff], ["Choose world evil", evil],
         ["Enter world name", name], ["Enter Seed", full]]
open(out, "w", encoding="utf-8").write(json.dumps(steps))
print("prefix=%s size=%s diff=%s evil=%s name=%s seedchars=%d"
      % (prefix, size, diff, evil, name, len(full)))
