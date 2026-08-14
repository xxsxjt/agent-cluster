#!/usr/bin/env python3
"""Extract ASCII/UTF-8 and UTF-16LE string runs from a .NET assembly and search for needles.
Prints offsets plus neighbouring strings so we can tell a real lookup table from a coincidence.
"""
import re
import sys

MIN = 5
PRINT = rb"[\x20-\x7e]"


def ascii_runs(b, minlen=MIN):
    out = []
    for m in re.finditer(PRINT + b"{%d,}" % minlen, b):
        out.append((m.start(), m.group().decode("ascii")))
    return out


def utf16_runs(b, minlen=MIN):
    out = []
    pat = re.compile(b"(?:" + PRINT + b"\x00){%d,}" % minlen)
    for m in pat.finditer(b):
        out.append((m.start(), m.group().decode("utf-16-le")))
    return out


def main():
    path = sys.argv[1]
    needles = sys.argv[2:]
    with open(path, "rb") as f:
        b = f.read()
    print("== %s  (%d bytes) ==" % (path, len(b)))
    a = ascii_runs(b)
    u = utf16_runs(b)
    print("ascii runs=%d  utf16 runs=%d" % (len(a), len(u)))

    for kind, runs in (("ASCII", a), ("UTF16", u)):
        idx = {}
        for i, (off, s) in enumerate(runs):
            idx[i] = (off, s)
        low = [(off, s, s.lower()) for off, s in runs]
        for n in needles:
            nl = n.lower()
            hits = [(i, off, s) for i, (off, s, sl) in enumerate(low) if nl in sl]
            if not hits:
                continue
            print("\n--- %s needle %r : %d hit(s) ---" % (kind, n, len(hits)))
            for i, off, s in hits[:6]:
                print("  @0x%x  %r" % (off, s[:200]))
                # neighbours give away lookup tables
                for j in range(max(0, i - 3), min(len(runs), i + 4)):
                    if j == i:
                        continue
                    print("      nb[%+d] %r" % (j - i, runs[j][1][:90]))


if __name__ == "__main__":
    main()
