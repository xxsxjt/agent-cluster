#!/usr/bin/env python3
"""Decide whether this build has a pipe-delimited multi-modifier seed system.
1) Terraria normalises seed text: trim + lower + remove spaces. So look for the
   SPACE-STRIPPED form of every token the user gave us.
2) Dump every string run that contains a '|' and looks like a seed token table.
"""
import re
import sys

PRINT = rb"[\x20-\x7e]"

USER = """abandoned manors|arachnophobia|beam me up|bring a towel|double daring dangers|fish mox|
hocus pocus|how did i get here|i am error|invisible plane|jagged rocks|jingle all the way|mole people|
monochrome|more traps please|negative infinity|night of the living dead|planetoids|pumpkin season|
purify this|rainbow road|royale with cheese|does that sparkle|too easy|water park|
what a horrible night to have a curse|winter is coming|x-ray vision|truck stop|sandy britches|
save the rainforest|such great heights|the care bears movie|toadstool|we don't even test for that"""
TOKENS = [t.strip() for t in USER.replace("\n", "").split("|") if t.strip()]


def runs(b, minlen=4):
    a = [(m.start(), m.group().decode("ascii")) for m in re.finditer(PRINT + b"{%d,}" % minlen, b)]
    u = [(m.start(), m.group().decode("utf-16-le"))
         for m in re.compile(b"(?:" + PRINT + b"\x00){%d,}" % minlen).finditer(b)]
    return a, u


def main():
    path = sys.argv[1]
    with open(path, "rb") as f:
        b = f.read()
    a, u = runs(b)
    print("== %s ==  ascii=%d utf16=%d" % (path, len(a), len(u)))

    print("\n########## space-stripped token lookup ##########")
    found, missing = [], []
    for t in TOKENS:
        norm = t.replace(" ", "").replace("'", "")
        norm2 = t.replace(" ", "")
        hits = []
        for kind, rr in (("A", a), ("U", u)):
            for off, s in rr:
                sl = s.lower()
                if norm in sl or norm2 in sl:
                    hits.append((kind, off, s))
        if hits:
            found.append(t)
            k, off, s = hits[0]
            print("  HIT  %-32s %s@0x%-9x %r  (%d total)" % (t, k, off, s[:120], len(hits)))
        else:
            missing.append(t)
    print("\n  found=%d  missing=%d" % (len(found), len(missing)))
    print("  MISSING: %s" % ", ".join(missing))

    print("\n########## every run containing '|' (seed-token shaped) ##########")
    seen = set()
    for kind, rr in (("ASCII", a), ("UTF16", u)):
        n = 0
        for off, s in rr:
            if "|" not in s:
                continue
            # seed-token shaped: lowercase letters/digits/pipes only
            if re.fullmatch(r"[a-z0-9|]{4,}", s) and s not in seen:
                seen.add(s)
                print("  %s @0x%-9x %r" % (kind, off, s[:160]))
                n += 1
                if n > 60:
                    print("  ... truncated")
                    break

    print("\n########## neighbourhood of 'pumpkinseason' ##########")
    for kind, rr in (("ASCII", a), ("UTF16", u)):
        for i, (off, s) in enumerate(rr):
            if "pumpkinseason" in s.lower():
                print("  --- %s hit @0x%x %r ---" % (kind, off, s))
                for j in range(max(0, i - 12), min(len(rr), i + 13)):
                    mark = ">>" if j == i else "  "
                    print("   %s [%+3d] %r" % (mark, j - i, rr[j][1][:110]))


if __name__ == "__main__":
    main()
