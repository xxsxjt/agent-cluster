#!/usr/bin/env python3
"""Connect via US public jump host, then check HK reachability from US."""
import paramiko

US_HOST = "103.119.14.102"
US_PORT = 45384
US_KEY = r"C:\Users\du_ji\.ssh\id_ed25519_xxsx_us"
HK_HOST = "100.97.18.59"
HK_PORT = 43891

def connect(host, port, keyfile, user="root"):
    c = paramiko.SSHClient()
    c.load_system_host_keys()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, key_filename=keyfile,
              timeout=30, banner_timeout=30, auth_timeout=30,
              allow_agent=False, look_for_keys=False)
    return c

def run(c, cmd, timeout=60):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode("utf-8", errors="replace")
    e = err.read().decode("utf-8", errors="replace")
    st = out.channel.recv_exit_status()
    return o, e, st

c = connect(US_HOST, US_PORT, US_KEY)
print("US_CONNECTED")
try:
    o,e,s = run(c, "hostname; uname -a | head -1; echo '---'; tailscale status 2>&1 | head -5")
    print("===US==="); print(o, e)
    o,e,s = run(c, f"ping -c 2 -W 2 {HK_HOST} 2>&1 | tail -3")
    print("===US->HK ping==="); print(o or e)
    o,e,s = run(c, f"bash -c 'echo > /dev/tcp/{HK_HOST}/{HK_PORT}' 2>&1 && echo HK_SSH_OPEN || echo HK_SSH_CLOSED")
    print("===US->HK SSH port==="); print(o or e)
    # ssh key from US to HK
    o,e,s = run(c, f"ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -p {HK_PORT} root@{HK_HOST} 'hostname; echo HK_SSH_OK' 2>&1 | tail -5")
    print("===US->HK ssh cmd==="); print(o or e)
finally:
    c.close()