#!/usr/bin/env python3
"""Verify /api/admin/host/status returns cpu_used_percent + disks on HK, using root access_token."""
from __future__ import annotations

import importlib.util
import json
import pathlib

ROOT = pathlib.Path(r"D:\dx\projects\xxsx-proxy-gateway").resolve()
HELPER_PATH = (
    ROOT / "engagements" / "release-20260721-mobile-recycle-r1" / "deploy-newapi-helper.py"
)
DB = "/data/xxsx-api/new-api-data/xxsx-new-api.db"


def main() -> None:
    spec = importlib.util.spec_from_file_location("hld_verify_helper", HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    us = module.connect(module.US_HOST, module.US_PORT, module.US_KEY, module.US_HOST_KEYS)
    transport = us.get_transport()
    jump = transport.open_channel(
        "direct-tcpip", (module.HK_TAILSCALE_HOST, module.HK_PORT), ("127.0.0.1", 0)
    )
    hk = module.connect(
        module.HK_HOST_KEY_NAME, module.HK_PORT, module.HK_KEY,
        r"C:\_dx\_serve\secrets\vps-hk-known-hosts", sock=jump,
    )
    try:
        cmd = (
            "set -euo pipefail\n"
            f"uid=$(sqlite3 -readonly {DB} \"select id from users where role=100 and status=1 order by id limit 1;\")\n"
            f"tok=$(sqlite3 -readonly {DB} \"select access_token from users where id=$uid and role=100 and status=1;\")\n"
            "test -n \"$tok\"\n"
            "printf 'UID=%s\\n' \"$uid\"\n"
            "host_code=$(curl --noproxy '*' -sS -o /tmp/hldv-host.json -w '%{http_code}' --max-time 20 "
            "-H \"Authorization: Bearer $tok\" -H \"New-Api-User: $uid\" "
            "http://127.0.0.1:3461/api/admin/host/status)\n"
            "printf 'HOST_CODE=%s\\n' \"$host_code\"\n"
            "test \"$host_code\" = 200\n"
            "cat /tmp/hldv-host.json\n"
            "rm -f /tmp/hldv-host.json\n"
        )
        out = module.run(hk, cmd, timeout=120)
        print(out.strip())
        for line in out.strip().splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            d = json.loads(line)
            s = d.get("data", d)
            cpu = s.get("cpu_used_percent")
            disks = s.get("disks") or []
            ok = cpu is not None and 0 <= float(cpu) <= 100 and len(disks) >= 1 and all(
                x.get("total_bytes", 0) > 0 and x.get("used_bytes", 0) >= 0
                and x.get("used_percent") is not None for x in disks
            )
            print("CPU_PERCENT=%.1f" % float(cpu))
            for i, x in enumerate(disks):
                print(
                    "DISK%d=%s used=%d total=%d pct=%.1f"
                    % (i + 1, x.get("path"), x.get("used_bytes"), x.get("total_bytes"), x.get("used_percent"))
                )
            print("HOST_VERIFY=%s" % ("ok" if ok else "FAIL"))
            if not ok:
                raise SystemExit(1)
    finally:
        hk.close()
        jump.close()
        us.close()


if __name__ == "__main__":
    main()
