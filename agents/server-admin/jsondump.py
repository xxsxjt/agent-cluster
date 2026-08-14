#!/usr/bin/env python3
"""Dump the ASCII region around a byte offset in a binary, and pull out JSON-ish key/value pairs.
Used to recover the embedded world-modifier description resource from OTAPI.dll.
"""
import re
import sys

path = sys.argv[1]
center = int(sys.argv[2], 0)
span = int(sys.argv[3]) if len(sys.argv) > 3 else 20000

with open(path, "rb") as f:
    b = f.read()

lo = max(0, center - span)
hi = min(len(b), center + span)
chunk = b[lo:hi]

# Longest printable run that contains the center
runs = [(m.start() + lo, m.group()) for m in re.finditer(rb"[\x09\x0a\x0d\x20-\x7e]{40,}", chunk)]
host = None
for off, r in runs:
    if off <= center < off + len(r):
        host = (off, r)
        break

print("== %s  center=0x%x  runs_in_window=%d ==" % (path, center, len(runs)))
if host:
    off, r = host
    print("-- containing run @0x%x  len=%d --" % (off, len(r)))
    txt = r.decode("ascii", "replace")
    print(txt)
else:
    print("-- center not inside a long printable run; dumping biggest runs --")
    for off, r in sorted(runs, key=lambda x: -len(x[1]))[:3]:
        print("-- @0x%x len=%d --" % (off, len(r)))
        print(r.decode("ascii", "replace")[:6000])
