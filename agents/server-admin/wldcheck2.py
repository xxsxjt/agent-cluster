#!/usr/bin/env python3
"""Terraria .wld header inspector (v2) — prints name/seed/size/GameMode plus a raw
hex window starting at GameMode so that seed-modifier booleans (if any) are visible.

Usage: wldcheck2.py <file.wld> [more.wld ...]
"""
import struct
import sys

GAMEMODE = {0: "Classic/Normal", 1: "Expert", 2: "Master", 3: "Journey/Creative"}
WINDOW = 160  # bytes to dump starting at the GameMode int


def rd_str(b, o):
    n = 0
    shift = 0
    while True:
        x = b[o]
        o += 1
        n |= (x & 0x7F) << shift
        if not x & 0x80:
            break
        shift += 7
    return b[o:o + n].decode("utf-8", "replace"), o + n


def check(path):
    with open(path, "rb") as f:
        b = f.read()
    ver = struct.unpack_from("<i", b, 0)[0]
    o = 4
    if ver >= 135:
        magic = b[o:o + 7].decode("ascii", "replace")
        o += 7 + 1 + 4 + 8
    else:
        magic = "(pre-135)"
    nsec = struct.unpack_from("<h", b, o)[0]
    o += 2
    ptrs = list(struct.unpack_from("<%di" % nsec, b, o))
    h = ptrs[0]
    p = h
    name, p = rd_str(b, p)
    seed, p = rd_str(b, p)
    str_bytes = p - h
    p += 8 + 16 + 4 + 16  # worldGenVer(8) guid(16) worldId(4) rect(16)
    ty, tx = struct.unpack_from("<ii", b, p)
    p += 8
    gm_off = p
    gm = struct.unpack_from("<i", b, p)[0]

    print("file        : %s" % path)
    print("wld version : %d   magic=%r  sections=%d  header@%d" % (ver, magic, nsec, h))
    print("world name  : %s" % name)
    print("seed        : %s" % seed)
    print("seed len    : %d chars" % len(seed))
    print("size        : %dx%d" % (tx, ty))
    print("GameMode    : %d -> %s" % (gm, GAMEMODE.get(gm, "?")))
    print("strbytes    : %d   GameMode at abs %d (header+%d)" % (str_bytes, gm_off, gm_off - h))

    win = b[gm_off:gm_off + WINDOW]
    print("hex window from GameMode (+0..+%d):" % (WINDOW - 1))
    for i in range(0, len(win), 32):
        chunk = win[i:i + 32]
        print("  +%3d  %s" % (i, " ".join("%02x" % c for c in chunk)))
    # count how many of the bytes right after the GameMode int look like bools
    tail = win[4:]
    run = 0
    for c in tail:
        if c in (0, 1):
            run += 1
        else:
            break
    ones = sum(1 for c in tail[:run] if c == 1)
    print("boolish run after GameMode: %d bytes, of which 0x01: %d" % (run, ones))
    print()


if __name__ == "__main__":
    for a in sys.argv[1:]:
        try:
            check(a)
        except Exception as e:
            print("%s -> ERROR %s: %s\n" % (a, type(e).__name__, e))
