#!/usr/bin/env python3
"""Publish user APK v0.6.9 (info-search entry 2x2 layout) to HK server."""
import hashlib, json, pathlib, time, paramiko

HK_HOST = "100.97.18.59"; HK_PORT = 43891
HK_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_hk"
HK_HOST_KEYS = r"C:\Users\du_ji\.ssh\known_hosts"
LOCAL_APK = pathlib.Path(r"D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-user-android\app\build\outputs\apk\debug\app-debug.apk")
REMOTE_RELEASE_DIR = "/opt/xxsx-api/releases"
REMOTE_APK = f"{REMOTE_RELEASE_DIR}/xxsx-user.apk"
REMOTE_MANIFEST = f"{REMOTE_APK}.json"
VERSION_CODE = 15; VERSION_NAME = "0.6.9"
ORIGIN = "https://api.xxssxx.top"
APK_PATH = "/downloads/xxsx-api-android.apk"
RELEASE_NOTES = (
    "xxsx 用户端 v0.6.9（信息搜索独立入口）：聊天室顶部按钮改 2×2 布局，"
    "「信息搜索」独立大按钮（私聊式收费会话，每观察员/总管回复扣 1 余额，使用前提示计费规则）；"
    "会话列表排序：聊天大厅 → 信息搜索 → 讨论总管 → 各频道。"
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
    backup = f"/opt/xxsx-api/backups/user-apk-v069-{stamp}"
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
        # 原子替换
        run(hk, f"mv -f {inc_apk} {REMOTE_APK}\nmv -f {inc_man} {REMOTE_MANIFEST}")
        # nginx reload
        run(hk, "nginx -t && nginx -s reload")
        # 校验
        remote_sha = run(hk, f"sha256sum {REMOTE_APK} | awk '{{print $1}}'").strip()
        remote_size = run(hk, f"stat -c %s {REMOTE_APK}").strip()
        man = run(hk, f"cat {REMOTE_MANIFEST}")
        print("REMOTE_SHA", remote_sha)
        print("REMOTE_SIZE", remote_size)
        print("MANIFEST", man[:400])
        assert remote_sha == apk_sha, "sha mismatch!"
        assert int(remote_size) == LOCAL_APK.stat().st_size, "size mismatch!"
        print("DEPLOY_OK")
    finally:
        hk.close()

if __name__ == "__main__":
    main()