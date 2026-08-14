#!/usr/bin/env python3
"""Deploy the host-load-display fix (CPU% + disk used/total) to HK production xxsx-api."""
from __future__ import annotations

import gzip
import hashlib
import importlib.util
import os
import pathlib
import shlex
import shutil
import tempfile
import time


ROOT = pathlib.Path(r"D:\dx\projects\xxsx-proxy-gateway").resolve()
HELPER_PATH = (
    ROOT
    / "engagements"
    / "release-20260721-mobile-recycle-r1"
    / "deploy-newapi-helper.py"
)
ARTIFACT = pathlib.Path(r"C:\_dx\_serve\new-api-linux-amd64-20260808-host-load-display")
VERSION = "v0.0.0-xxsx.host-load-display.1-20260808"
EXPECTED_SHA256 = "39fe46703e82cab1a8abb08a1649d88aa147b8907060cef884afb8ec2658c278"
SERVICE = "xxsx-api-mi"
REMOTE_BINARY = "/opt/xxsx-api/bin/new-api"
REMOTE_DATABASE = "/data/xxsx-api/new-api-data/xxsx-new-api.db"
BACKUP_ROOT = "/data/xxsx-api/server-backups"
RECYCLE_ROOT = "/data/xxsx-api/recycle/deploy-artifacts"
RELEASE = "host-load-display-20260808"

LOGIN_USER = os.environ.get("XXSX_ADMIN_USER", "root")
LOGIN_PASS = os.environ.get("XXSX_ADMIN_PASSWORD", "")


def load_helper():
    spec = importlib.util.spec_from_file_location("xxsx_hostload_deploy_helper", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("the verified deployment helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def recycle_local(path: pathlib.Path) -> None:
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass


def wait_for_health(helper, client, timeout: int = 120) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            code = helper.run(
                client,
                "curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "
                "http://127.0.0.1:3461/api/status",
                timeout=10,
            ).strip()
            if code == "200":
                return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("NewAPI health check timed out")


def restore(helper, client, backup: str, recycle: str) -> None:
    helper.run(
        client,
        "set +e\n"
        f"install -d -o root -g root -m 700 {recycle}\n"
        f"systemctl stop {SERVICE}\n"
        f"if test -f {REMOTE_BINARY}; then mv {REMOTE_BINARY} {recycle}/new-api.failed; fi\n"
        "for suffix in -wal -shm; do current=\"" + REMOTE_DATABASE + "$suffix\"; "
        "if test -e \"$current\"; then mv \"$current\" " + recycle + "/xxsx-new-api.db$suffix.failed; fi; done\n"
        f"cp -a {backup}/new-api {REMOTE_BINARY}\n"
        f"cp -a {backup}/xxsx-new-api.db {REMOTE_DATABASE}\n"
        f"systemctl start {SERVICE}\n",
        timeout=180,
    )
    wait_for_health(helper, client)


def verify_host_status(helper, client) -> None:
    """Root-login then GET /api/admin/host/status; assert cpu_used_percent + disks used/total."""
    if not LOGIN_PASS:
        print("SKIP_HOST_ENDPOINT=no admin password provided")
        return
    cmd = (
        "set -euo pipefail\n"
        # login and capture session cookie
        "cookie=/tmp/hld-verify.cookie; rm -f $cookie\n"
        "login_code=$(curl --noproxy '*' -sS -o /tmp/hld-login.json -w '%{http_code}' --max-time 15 "
        "-c $cookie -H 'Content-Type: application/json' "
        "-d '" + _json_escape({"username": LOGIN_USER, "password": LOGIN_PASS}) + "' "
        "http://127.0.0.1:3461/api/user/login)\n"
        "printf 'LOGIN_CODE=%s\\n' \"$login_code\"\n"
        "if test \"$login_code\" != 200; then cat /tmp/hld-login.json; exit 9; fi\n"
        # get host status
        "host_code=$(curl --noproxy '*' -sS -o /tmp/hld-host.json -w '%{http_code}' --max-time 15 "
        "-b $cookie http://127.0.0.1:3461/api/admin/host/status)\n"
        "printf 'HOST_CODE=%s\\n' \"$host_code\"\n"
        "test \"$host_code\" = 200\n"
        "python3 - <<'PY'\n"
        "import json,sys\n"
        "d=json.load(open('/tmp/hld-host.json'))\n"
        "s=d.get('data',d)\n"
        "cpu=s.get('cpu_used_percent')\n"
        "assert cpu is not None and isinstance(cpu,(int,float)) and 0<=cpu<=100, 'cpu_used_percent missing/invalid: %r'%cpu\n"
        "disks=s.get('disks') or []\n"
        "assert len(disks)>=1, 'no disks reported'\n"
        "for disk in disks:\n"
        "    assert disk.get('total_bytes',0)>0 and disk.get('used_bytes',0)>=0 and disk.get('used_percent') is not None, disk\n"
        "print('CPU_PERCENT=%.1f'%cpu)\n"
        "for i,disk in enumerate(disks):\n"
        "    print('DISK%d=%s used=%d total=%d pct=%.1f'%(i+1,disk.get('path'),disk.get('used_bytes'),disk.get('total_bytes'),disk.get('used_percent')))\n"
        "print('HOST_VERIFY=ok')\n"
        "PY\n"
        "rm -f $cookie /tmp/hld-login.json /tmp/hld-host.json\n"
    )
    helper.run(client, cmd, timeout=120)
    print("HOST_ENDPOINT_VERIFIED=yes")


def _json_escape(obj) -> str:
    import json as _json
    return shlex.quote(_json.dumps(obj))


def main() -> None:
    if not ARTIFACT.is_file():
        raise RuntimeError(f"deployment artifact is missing: {ARTIFACT}")
    artifact_sha = sha256(ARTIFACT)
    if artifact_sha != EXPECTED_SHA256:
        raise RuntimeError(f"artifact SHA mismatch: {artifact_sha}")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{BACKUP_ROOT}/{RELEASE}-{stamp}"
    recycle = f"{RECYCLE_ROOT}/{RELEASE}-{stamp}"
    remote_archive = f"/tmp/new-api-{RELEASE}-{stamp}.gz"
    remote_candidate = f"/tmp/new-api-{RELEASE}-{stamp}"
    remote_next = f"{REMOTE_BINARY}.next"
    local_archive = pathlib.Path(tempfile.gettempdir()) / f"new-api-{RELEASE}-{stamp}.gz"

    with ARTIFACT.open("rb") as source, local_archive.open("wb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", compresslevel=3, mtime=0) as compressed:
            shutil.copyfileobj(source, compressed, 1024 * 1024)

    helper = load_helper()
    us = helper.connect(helper.US_HOST, helper.US_PORT, helper.US_KEY, helper.US_HOST_KEYS)
    transport = us.get_transport()
    if transport is None:
        us.close()
        recycle_local(local_archive)
        raise RuntimeError("US jump-host transport is unavailable")
    jump = transport.open_channel(
        "direct-tcpip", (helper.HK_TAILSCALE_HOST, helper.HK_PORT), ("127.0.0.1", 0)
    )
    hk = helper.connect(
        helper.HK_HOST_KEY_NAME, helper.HK_PORT, helper.HK_KEY,
        r"C:\_dx\_serve\secrets\vps-hk-known-hosts", sock=jump,
    )

    try:
        preflight = helper.run(
            hk,
            "set -euo pipefail\n"
            f"test -x {REMOTE_BINARY}\n"
            f"test -f {REMOTE_DATABASE}\n"
            f"test \"$(systemctl is-active {SERVICE})\" = active\n"
            f"test \"$(systemctl is-enabled {SERVICE})\" = enabled\n"
            "test \"$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 6 "
            "http://127.0.0.1:3461/api/status)\" = 200\n"
            f"test \"$(sqlite3 -readonly {REMOTE_DATABASE} 'pragma quick_check;' | head -1)\" = ok\n"
            "test $(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo) -gt 500\n"
            "test $(df -Pk /data/xxsx-api | awk 'NR==2 {print $4}') -gt 500000\n"
            f"printf 'SERVICE='; systemctl is-active {SERVICE}\n"
            f"printf 'ENABLED='; systemctl is-enabled {SERVICE}\n"
            f"printf 'DB_CHECK='; sqlite3 -readonly {REMOTE_DATABASE} 'pragma quick_check;' | head -1\n"
            f"printf 'USERS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from users;'\n"
            f"printf 'CHANNELS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from channels;'\n"
            f"printf 'TOKENS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from tokens;'\n"
            f"printf 'OLD_SHA='; sha256sum {REMOTE_BINARY} | awk '{{print $1}}'\n",
            timeout=90,
        )
        print(preflight.strip())
        counts = dict(line.split("=", 1) for line in preflight.splitlines() if "=" in line)

        helper.run(
            hk,
            "set -euo pipefail\n"
            f"install -d -o root -g root -m 700 {backup} {recycle}\n"
            f"cp -a {REMOTE_BINARY} {backup}/new-api\n"
            f"sqlite3 -cmd '.timeout 30000' {REMOTE_DATABASE} \".backup '{backup}/xxsx-new-api.db'\"\n"
            f"chown --reference={REMOTE_DATABASE} {backup}/xxsx-new-api.db\n"
            f"chmod --reference={REMOTE_DATABASE} {backup}/xxsx-new-api.db\n"
            f"test \"$(sqlite3 -readonly {backup}/xxsx-new-api.db 'pragma quick_check;' | head -1)\" = ok\n"
            f"systemctl cat {SERVICE} > {backup}/{SERVICE}.service.txt\n"
            f"systemctl show {SERVICE} > {backup}/{SERVICE}.show.txt\n",
            timeout=120,
        )

        sftp = hk.open_sftp()
        try:
            sftp.put(str(local_archive), remote_archive, confirm=True)
            sftp.chmod(remote_archive, 0o600)
        finally:
            sftp.close()

        transition_started = False
        try:
            helper.run(
                hk,
                "set -euo pipefail\n"
                f"gzip -dc {shlex.quote(remote_archive)} > {shlex.quote(remote_candidate)}\n"
                f"chmod 755 {shlex.quote(remote_candidate)}\n"
                f"test \"$(sha256sum {shlex.quote(remote_candidate)} | awk '{{print $1}}')\" = '{artifact_sha}'\n"
                f"test \"$({shlex.quote(remote_candidate)} -version)\" = '{VERSION}'\n"
                f"install -o root -g root -m 755 {shlex.quote(remote_candidate)} {remote_next}\n"
                f"test \"$(sha256sum {remote_next} | awk '{{print $1}}')\" = '{artifact_sha}'\n",
                timeout=180,
            )
            helper.run(hk, f"systemctl stop {SERVICE}\n", timeout=60)
            transition_started = True
            helper.run(
                hk,
                "set -euo pipefail\n"
                # ETXTBSY guard: release any stale writer (residual sftp-server) before replacing.
                f"fuser -k {REMOTE_BINARY} 2>/dev/null || true\n"
                "sleep 2\n"
                "set -e\n"
                f"rm -f {REMOTE_BINARY}\n"
                f"install -o root -g root -m 755 {remote_next} {REMOTE_BINARY}\n"
                f"systemctl start {SERVICE}\n",
                timeout=90,
            )
            wait_for_health(helper, hk)
            verification = helper.run(
                hk,
                "set -euo pipefail\n"
                f"test \"$(sha256sum {REMOTE_BINARY} | awk '{{print $1}}')\" = '{artifact_sha}'\n"
                f"test \"$({REMOTE_BINARY} -version)\" = '{VERSION}'\n"
                f"test \"$(sqlite3 -readonly {REMOTE_DATABASE} 'pragma quick_check;' | head -1)\" = ok\n"
                f"test \"$(sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from users;')\" = '{counts['USERS']}'\n"
                f"test \"$(sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from channels;')\" = '{counts['CHANNELS']}'\n"
                f"test \"$(sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from tokens;')\" = '{counts['TOKENS']}'\n"
                f"printf 'SERVICE='; systemctl is-active {SERVICE}\n"
                "printf 'LOCAL_STATUS='; curl --noproxy '*' -sS -o /dev/null -w '%{http_code}\\n' --max-time 8 http://127.0.0.1:3461/api/status\n"
                "printf 'PUBLIC_STATUS='; curl --noproxy '*' -sS -o /dev/null -w '%{http_code}\\n' --max-time 20 https://api.xxssxx.top/api/status\n"
                f"printf 'VERSION='; {REMOTE_BINARY} -version\n"
                f"printf 'NEW_SHA='; sha256sum {REMOTE_BINARY} | awk '{{print $1}}'\n"
                f"printf 'DB_CHECK='; sqlite3 -readonly {REMOTE_DATABASE} 'pragma quick_check;' | head -1\n"
                f"printf 'USERS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from users;'\n"
                f"printf 'CHANNELS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from channels;'\n"
                f"printf 'TOKENS='; sqlite3 -readonly {REMOTE_DATABASE} 'select count(*) from tokens;'\n"
                f"printf 'RESTARTS='; systemctl show {SERVICE} -p NRestarts --value\n"
                f"printf 'MEMORY='; systemctl show {SERVICE} -p MemoryCurrent --value\n"
                f"printf 'RECENT_ERRORS='; journalctl -u {SERVICE} --since '3 minutes ago' --no-pager -p err | grep -vc '^-- No entries --$' || true\n",
                timeout=120,
            )
            print(verification.strip())
            verify_host_status(helper, hk)
            transition_started = False
        except BaseException:
            if transition_started:
                restore(helper, hk, backup, recycle)
            else:
                helper.run(hk, f"systemctl start {SERVICE} || true", timeout=60)
                wait_for_health(helper, hk)
            raise
        finally:
            helper.run(
                hk,
                "set -euo pipefail\n"
                f"for item in {shlex.quote(remote_archive)} {shlex.quote(remote_candidate)} {remote_next}; do\n"
                f"  if test -e \"$item\"; then mv \"$item\" {recycle}/; fi\n"
                "done\n",
                timeout=30,
            )

        print(f"BACKUP={backup}")
    finally:
        hk.close()
        jump.close()
        us.close()
        recycle_local(local_archive)


if __name__ == "__main__":
    main()
