#!/usr/bin/env python3
"""Locate Terraria's seed-related string tables inside OTAPI assemblies.

Strategy: string literals in .NET live in the #US heap as UTF-16LE and are
usually emitted in source order, so the *neighbours* of a known secret-seed
literal reveal the whole lookup table. Also dumps neighbours of the
"{0}.{1}.{2}.{3}." version-prefix format string (candidate for the
"1.1.1.0.<flags>" seed encoding).
"""
import re
import sys

PRINT = rb"[\x09\x20-\x7e]"


def utf16_runs(b, minlen=3):
    pat = re.compile(b"(?:" + PRINT + rb"\x00){%d,}" % minlen)
    return [(m.start(), m.group().decode("utf-16-le")) for m in pat.finditer(b)]


def ascii_runs(b, minlen=4):
    pat = re.compile(PRINT + b"{%d,}" % minlen)
    return [(m.start(), m.group().decode("ascii")) for m in pat.finditer(b)]


def dump_around(runs, needle, before, after, label, limit=3):
    nl = needle.lower()
    hits = [i for i, (_, s) in enumerate(runs) if nl in s.lower()]
    print("\n########## %s : needle %r -> %d hit(s) ##########" % (label, needle, len(hits)))
    for h in hits[:limit]:
        print("---- hit @0x%x ----" % runs[h][0])
        for j in range(max(0, h - before), min(len(runs), h + after + 1)):
            mark = ">>" if j == h else "  "
            print("  %s [%+4d] %r" % (mark, j - h, runs[j][1][:110]))


def main():
    path = sys.argv[1]
    with open(path, "rb") as f:
        b = f.read()
    u = utf16_runs(b)
    a = ascii_runs(b)
    print("== %s == utf16 runs=%d ascii runs=%d" % (path, len(u), len(a)))

    for needle, before, after, lim in (
        ("celebrationmk10", 45, 45, 1),
        ("{0}.{1}.{2}.{3}.", 25, 45, 2),
    ):
        dump_around(u, needle, before, after, "UTF16", lim)

    for needle in ("not the bees", "for the worthy", "planetoids", "bring a towel"):
        dump_around(a, needle, 6, 6, "ASCII", 2)


if __name__ == "__main__":
    main()
