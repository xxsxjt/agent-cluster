#!/usr/bin/env python3
"""webshare 双层代理封装：本机 -> clash(7890) -> webshare residential -> 目标。
OPSEC：出口为 webshare 住宅轮转 IP，不暴露本机。
用法:
  python tools/ws_proxy.py "https://ifconfig.me" [--user uwsampli] [--out FILE]
  python tools/ws_proxy.py --exit        # 显示当前出口 IP
"""
import socket, base64, ssl, json, sys, argparse, time

CLASH=("127.0.0.1", 7890)
WS_HOST="p.webshare.io"; WS_PORT=80
WS_PASS="j5c6hsgm707p"
BASE_USER="uwlkamjv"

def read_status(sock):
    data=b""
    while b"\r\n\r\n" not in data:
        d=sock.recv(4096)
        if not d: break
        data+=d
    return data

def fetch(url, user=BASE_USER, method="GET", headers=None, body=None, timeout=40):
    """经 clash+webshare 抓取 URL，返回响应体字符串。"""
    scheme, rest = url.split("://",1)
    host = rest.split("/")[0]
    if ":" in host:
        host, port_str = host.rsplit(":",1)
        port = int(port_str)
    else:
        port = 443 if scheme=="https" else 80
    slash = rest.find("/")
    path = rest[slash:] if slash!=-1 else "/"
    s=socket.create_connection(CLASH, timeout=timeout)
    s.sendall(f"CONNECT {WS_HOST}:{WS_PORT} HTTP/1.1\r\nHost: {WS_HOST}:{WS_PORT}\r\n\r\n".encode())
    read_status(s)
    auth=base64.b64encode(f"{user}:{WS_PASS}".encode()).decode()
    s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n".encode())
    r2=read_status(s).split(b"\r\n")[0].decode()
    if b"200" not in r2.encode():
        s.close(); return f"ERROR tunnel: {r2}"
    hdrs = f"Host: {host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nAccept: text/html,application/json\r\nConnection: close\r\n"
    if headers:
        for k,v in headers.items(): hdrs += f"{k}: {v}\r\n"
    req = f"{method} {path} HTTP/1.1\r\n{hdrs}\r\n"
    if body: req += body
    if scheme=="https":
        ctx=ssl.create_default_context()
        sock=ctx.wrap_socket(s, server_hostname=host)
    else:
        sock=s
    sock.sendall(req.encode())
    resp=b""
    while True:
        try:
            d=sock.recv(8192)
        except ssl.SSLError:
            break
        if not d: break
        resp+=d
    sock.close()
    # split status line, headers, body
    txt=resp.decode(errors='ignore')
    parts=txt.split("\r\n\r\n",1)
    head=parts[0] if parts else ""
    bodyx=parts[1] if len(parts)>1 else ""
    status=head.split("\r\n")[0] if head else ""
    # gzip decode if present
    if "Content-Encoding: gzip" in head:
        import gzip
        try: bodyx=gzip.decompress(resp.split(b"\r\n\r\n",1)[1]).decode(errors='ignore')
        except Exception: pass
    return f"STATUS {status}\n{bodyx}"

def exit_ip(user=BASE_USER):
    r=fetch("https://ipinfo.io/json", user=user)
    for line in r.splitlines():
        if "STATUS" in line: continue
        if '"ip"' in line:
            return line.strip()
    return r[:200]

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", help="要抓取的 URL")
    ap.add_argument("--user", default=BASE_USER)
    ap.add_argument("--exit", action="store_true", help="显示当前出口 IP")
    ap.add_argument("--out", default=None)
    args=ap.parse_args()
    if args.exit:
        print(exit_ip(args.user)); sys.exit(0)
    if not args.url:
        print("需要 URL 或 --exit"); sys.exit(1)
    r=fetch(args.url, user=args.user)
    if args.out:
        with open(args.out,"w",encoding="utf-8") as f: f.write(r)
        print(f"saved {len(r)} bytes -> {args.out}")
    else:
        print(r)
