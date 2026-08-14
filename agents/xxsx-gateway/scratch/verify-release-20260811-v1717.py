#!/usr/bin/env python3
"""Verify admin v1.7.17 update channel: temp mobile token, app-release + download sha, revoke."""
from __future__ import annotations

import hashlib
import secrets
import time

import paramiko

HK_HOST = "100.97.18.59"
HK_PORT = 43891
HK_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_hk"
HK_HOST_KEYS = r"C:\Users\du_ji\.ssh\known_hosts"
DB = "/data/xxsx-api/new-api-data/xxsx-new-api.db"
API = "http://127.0.0.1:3461"

EXPECT_CODE = 51
EXPECT_NAME = "1.7.17"
EXPECT_SHA = "5e7e40eff8692494fa0a4ef04b15c533f3341bbae0afff2e88a94997a950aaf3"
EXPECT_SIZE = 6557039


def connect():
    client = paramiko.SSHClient()
    client.load_host_keys(HK_HOST_KEYS)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(HK_HOST, port=HK_PORT, username="root", key_filename=HK_KEY,
                   timeout=30, banner_timeout=30, auth_timeout=30,
                   allow_agent=False, look_for_keys=False)
    return client


def run(client, command, timeout=120):
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    status = stdout.channel.recv_exit_status()
    if status != 0:
        raise RuntimeError(err.strip() or out.strip() or f"remote exit {status}")
    return out


def main():
    token = "xxsxadm_" + secrets.token_hex(16)
    thash = hashlib.sha256(token.encode()).hexdigest()
    expires = int(time.time()) + 600
    name = f"release-v1717-verify-{int(time.time())}"

    hk = connect()
    try:
        run(hk, f"sqlite3 '{DB}' \"INSERT INTO admin_mobile_devices (user_id,name,token_hash,scopes,expires_at,created_at) VALUES (1,'{name}','{thash}','*',{expires},{int(time.time()*1000)});\"")
        print(f"TOKEN_CREATED device={name}")

        esc = token.replace("'", "\\'")
        code = run(hk, f"curl -sS -o /tmp/release1717.json -w '%{{http_code}}' --max-time 15 -H 'Authorization: Bearer {esc}' {API}/api/mobile/admin/app-release").strip()
        release = run(hk, "cat /tmp/release1717.json").strip()
        print(f"APP_RELEASE_HTTP={code}")
        print(f"APP_RELEASE_BODY={release[:400]}")
        assert code == "200", f"expected 200 got {code}"
        assert f'"version_code":{EXPECT_CODE}' in release
        assert f'"version_name":"{EXPECT_NAME}"' in release
        assert EXPECT_SHA in release, "sha256 not in release body"

        run(hk, f"curl -sS -o /tmp/xxsx-admin-1717.apk -w '%{{http_code}}' --max-time 60 -H 'Authorization: Bearer {esc}' {API}/api/mobile/admin/app-release/download")
        remote_sha = run(hk, "sha256sum /tmp/xxsx-admin-1717.apk | awk '{print $1}'").strip()
        remote_size = run(hk, "stat -c %s /tmp/xxsx-admin-1717.apk").strip()
        print(f"ADMIN_DOWNLOAD_SHA={remote_sha}")
        print(f"ADMIN_DOWNLOAD_BYTES={remote_size}")
        assert remote_sha == EXPECT_SHA, f"admin download sha mismatch {remote_sha}"
        assert remote_size == str(EXPECT_SIZE), f"admin download size mismatch {remote_size}"

        print("E2E_ALL_MATCH=YES")
    finally:
        run(hk, f"sqlite3 '{DB}' \"DELETE FROM admin_mobile_devices WHERE name='{name}';\"")
        print(f"TOKEN_REVOKED device={name}")


if __name__ == "__main__":
    main()