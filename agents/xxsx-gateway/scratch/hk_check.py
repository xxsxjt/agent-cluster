#!/usr/bin/env python3
"""Check HK twin-proxy state: binary build source, config, tailscale reachability."""
import paramiko

HK_HOST = "100.97.18.59"
HK_PORT = 43891
HK_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_hk"
HK_HOST_KEYS = r"C:\Users\du_ji\.ssh\known_hosts"

def connect():
    c = paramiko.SSHClient()
    c.load_host_keys(HK_HOST_KEYS)
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(HK_HOST, port=HK_PORT, username="root", key_filename=HK_KEY,
              timeout=30, banner_timeout=30, auth_timeout=30,
              allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, timeout=60):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", errors="replace")
    e = err.read().decode("utf-8", errors="replace")
    st = out.channel.recv_exit_status()
    return o, e, st

c = connect()
try:
    # binary timestamp + size
    o,e,s = run(c, "ls -la /opt/xxsx-api/bin/new-api; stat -c '%y %s' /opt/xxsx-api/bin/new-api")
    print("===BIN==="); print(o, e)
    # does binary contain twin marker strings?
    o,e,s = run(c, "strings /opt/xxsx-api/bin/new-api | grep -iE 'twinVirtual|fetchTwinHistory|adminAssistantConversationKindTwin|虚无圣灵' | head -10")
    print("===BIN_MARKERS==="); print(o or "(none)")
    # config
    o,e,s = run(c, "grep -iE 'AssistantTwin|assistant.*twin|TwinEndpoint|TwinToken|TwinEnabled' /opt/xxsx-api/*.env /opt/xxsx-api/.env 2>/dev/null | sed 's/\\(TOKEN *= *[^ ]*\\).*/\\1<redacted>/I' | head -20")
    print("===CONFIG==="); print(o or "(no env match)")
    # database config table
    o,e,s = run(c, "sqlite3 /data/xxsx-api/new-api-data/xxsx-new-api.db \"SELECT key, substr(value,1,80) FROM settings WHERE key LIKE '%Twin%';\" 2>&1 | head -20")
    print("===DB_SETTINGS==="); print(o or e or "(none)")
    # process running
    o,e,s = run(c, "ps aux | grep -E 'new-api|xxsx-api' | grep -v grep | head -5")
    print("===PROC==="); print(o or "(none)")
    # port
    o,e,s = run(c, "ss -tlnp | grep -E '3461|8787' | head")
    print("===PORT==="); print(o or "(none)")
    # can HK reach local tailscale?
    o,e,s = run(c, "tailscale status 2>&1 | head -3; echo '---'; ping -c 2 -W 2 100.103.204.86 2>&1 | tail -3")
    print("===HK_TS==="); print(o or e)
finally:
    c.close()