#!/usr/bin/env python3
"""补验 app-fixes-20260810：实时确认线上 app-release 更新通道 + 令牌 id=108 永久化状态。
临时 admin token 测后吊销。SSH: 103.100.159.111:43891
"""
from __future__ import annotations
import hashlib, secrets, time, json
import paramiko

HK_HOST = "103.100.159.111"
HK_PORT = 43891
HK_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_hk"
HK_HOST_KEYS = r"C:\Users\du_ji\.ssh\known_hosts"
DB = "/data/xxsx-api/new-api-data/xxsx-new-api.db"
API = "http://127.0.0.1:3461"

def connect():
    c = paramiko.SSHClient()
    c.load_host_keys(HK_HOST_KEYS)
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(HK_HOST, port=HK_PORT, username="root", key_filename=HK_KEY,
              timeout=30, banner_timeout=30, auth_timeout=30,
              allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, timeout=120):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", errors="replace")
    e = err.read().decode("utf-8", errors="replace")
    st = out.channel.recv_exit_status()
    return o, e, st

def main():
    c = connect()
    try:
        # 1) 令牌 id=108 永久化状态
        o, e, s = run(c, f"sqlite3 '{DB}' \"SELECT id,name,expires_at,revoked_at,created_at FROM admin_mobile_devices WHERE id IN (108,109);\"")
        print("=== TOKEN id=108/109 状态 ===")
        print(o.strip() or "(无记录)")
        # 断言 108 永久（4102444800 常量 or 0），revoked=0
        if "108|" in o:
            row = [x for x in o.strip().splitlines() if x.startswith("108|")][0]
            parts = row.split("|")
            if len(parts) >= 4:
                exp, rev = parts[2], parts[3]
                perm = exp in ("0", "4102444800")
                print(f"  -> id=108 expires_at={exp} revoked_at={rev} 永久性={perm} 活跃={rev=='0'}")
                assert perm and rev == "0", f"id=108 未永久化/已吊销: {row}"
        else:
            print("  !! 未找到 id=108 记录")
            raise AssertionError("id=108 不存在")

        # 2) 当前线上 app-release（临时 token scopes *，测后吊销）
        token = "xxsxadm_" + secrets.token_hex(16)
        thash = hashlib.sha256(token.encode()).hexdigest()
        expires = int(time.time()) + 600
        name = f"improve-verify-{int(time.time())}"
        run(c, f"sqlite3 '{DB}' \"INSERT INTO admin_mobile_devices (user_id,name,token_hash,scopes,expires_at,created_at) VALUES (1,'{name}','{thash}','*',{expires},{int(time.time()*1000)});\"")
        print("=== TOKEN_CREATED device=%s ===" % name)
        esc = token.replace("'", "\\'")
        code = run(c, f"curl -sS -o /tmp/improve-rel.json -w '%{{http_code}}' --max-time 15 -H 'Authorization: Bearer {esc}' {API}/api/mobile/admin/app-release")[0].strip()
        body = run(c, "cat /tmp/improve-rel.json")[0].strip()
        print(f"APP_RELEASE_HTTP={code}")
        print(f"APP_RELEASE_BODY={body[:400]}")
        assert code == "200", f"app-release 期望 200 得 {code}"
        rel = json.loads(body)
        print(f"  -> 更新通道版本 version_code={rel.get('version_code')} version_name={rel.get('version_name')} available={rel.get('available')}")

        # 3) 下载 sha 一致性（管理端）
        dcode = run(c, f"curl -sS -o /tmp/improve-admin.apk -w '%{{http_code}}' --max-time 60 -H 'Authorization: Bearer {esc}' {API}/api/mobile/admin/app-release/download")[0].strip()
        dsha = run(c, "sha256sum /tmp/improve-admin.apk")[0].strip().split()[0]
        dsize = run(c, "stat -c '%s' /tmp/improve-admin.apk")[0].strip()
        print(f"DOWNLOAD_HTTP={dcode} sha256={dsha} size={dsize}")
        print(f"  -> 通道声明 sha={rel.get('sha256')} 实际下载 sha={dsha} 一致={rel.get('sha256')==dsha}")

        # 4) 用户端下载通道 sha（免 token）
        usha = run(c, "sha256sum /var/www/html/downloads/xxsx-api-android.apk 2>/dev/null || sha256sum /opt/xxsx-api/releases/xxsx-user.apk 2>/dev/null || find / -name 'xxsx-user.apk' 2>/dev/null | head -1 | xargs sha256sum 2>/dev/null")[0].strip()
        print(f"USER_CHANNEL_SHA={usha}")

        # 5) 吊销临时 token
        run(c, f"sqlite3 '{DB}' \"DELETE FROM admin_mobile_devices WHERE name='{name}' AND id NOT IN (SELECT id FROM admin_mobile_devices WHERE id IN (108,109));\"")
        print("=== TEMP_TOKEN_REVOKED ===")
    finally:
        c.close()

if __name__ == "__main__":
    main()
