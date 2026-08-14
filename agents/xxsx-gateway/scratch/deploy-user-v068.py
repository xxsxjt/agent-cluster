#!/usr/bin/env python3
"""Publish user APK v0.6.8 (download URL fallback fix) to HK server."""
import hashlib, json, pathlib, time, paramiko

HK_HOST = "100.97.18.59"; HK_PORT = 43891
HK_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_hk"
HK_HOST_KEYS = r"C:\Users\du_ji\.ssh\known_hosts"
LOCAL_APK = pathlib.Path(r"D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-user-android\app\build\outputs\apk\debug\app-debug.apk")
REMOTE_RELEASE_DIR = "/opt/xxsx-api/releases"
REMOTE_APK = f"{REMOTE_RELEASE_DIR}/xxsx-user.apk"
REMOTE_MANIFEST = f"{REMOTE_APK}.json"
NGINX_CONF = "/etc/nginx/conf.d/xxsx-api.conf"
VERSION_CODE = 14; VERSION_NAME = "0.6.8"
ORIGIN = "https://api.xxssxx.top"
APK_PATH = "/downloads/xxsx-api-android.apk"
RELEASE_NOTES = (
    "xxsx 用户端 v0.6.8（更新下载修复）："
    "修复更新清单字段缺失时下载失败（403）的问题，下载 URL 增加默认兜底路径；"
    "功能与 v0.6.7 一致（信息搜索/追搜/观察员/总管家能力）。"
)

def connect():
    c = paramiko.SSHClient()
    c.load_host_keys(HK_HOST_KEYS)
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(HK_HOST, port=HK_PORT, username="root", key_filename=HK_KEY, timeout=30,
              banner_timeout=30, auth_timeout=30, allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, timeout=180):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", errors="replace"); e = err.read().decode("utf-8", errors="replace")
    st = out.channel.recv_exit_status()
    if st != 0: raise RuntimeError(e.strip() or o.strip() or f"exit {st}")
    return o

def main():
    if not LOCAL_APK.is_file(): raise RuntimeError(f"APK missing: {LOCAL_APK}")
    apk_sha = hashlib.sha256(LOCAL_APK.read_bytes()).hexdigest()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"/opt/xxsx-api/backups/user-apk-v068-{stamp}"
    inc_apk = f"{REMOTE_RELEASE_DIR}/.xxsx-user-{stamp}.apk"
    inc_man = f"{REMOTE_RELEASE_DIR}/.xxsx-user-{stamp}.json"
    manifest = {
        "version_code": VERSION_CODE, "version_name": VERSION_NAME,
        "size_bytes": LOCAL_APK.stat().st_size, "sha256": apk_sha,
        "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "release_notes": RELEASE_NOTES,
        "download_url": f"{ORIGIN}{APK_PATH}?v={VERSION_CODE}", "min_sdk": 26,
    }
    hk = connect()
    try:
        run(hk, f"install -d -m 700 {backup}")
        run(hk, f"if [ -f {REMOTE_APK} ]; then cp -a {REMOTE_APK} {backup}/; fi\nif [ -f {REMOTE_MANIFEST} ]; then cp -a {REMOTE_MANIFEST} {backup}/; fi")
        sftp = hk.open_sftp()
        try:
            sftp.put(str(LOCAL_APK), inc_apk)
            with sftp.file(inc_man, "w") as f: f.write(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
        finally:
            sftp.close()
        v = run(hk, "set -euo pipefail\n"
            f"test \"$(sha256sum {inc_apk} | awk '{{print $1}}')\" = '{apk_sha}'\n"
            f"chown root:root {inc_apk} {inc_man}\nchmod 644 {inc_apk} {inc_man}\n"
            f"mv -f {inc_apk} {REMOTE_APK}\nmv -f {inc_man} {REMOTE_MANIFEST}\n"
            f"grep -q '\"version_code\":{VERSION_CODE}' {REMOTE_MANIFEST}\n"
            f"sed -i 's/xxsx-api-android-0\\.6\\.[0-9]*\\.apk/xxsx-api-android-{VERSION_NAME}.apk/g' {NGINX_CONF} || true\n"
            "nginx -t && systemctl reload nginx\nsleep 2\n"
            f"curl -kfsS --resolve api.xxssxx.top:443:127.0.0.1 {ORIGIN}{APK_PATH} | sha256sum | awk '{{print $1}}'\n"
            f"curl -kfsS --resolve api.xxssxx.top:443:127.0.0.1 {ORIGIN}{APK_PATH.replace('.apk','.json')} | grep -q '\"version_code\":{VERSION_CODE}'\n"
            "printf 'NGINX='; systemctl is-active nginx\n"
            f"printf 'APK_SHA='; sha256sum {REMOTE_APK} | awk '{{print $1}}'\n"
            f"printf 'APK_BYTES='; stat -c %s {REMOTE_APK}\n")
        print(v.strip())
        print(f"BACKUP={backup}")
    finally:
        hk.close()

if __name__ == "__main__":
    main()