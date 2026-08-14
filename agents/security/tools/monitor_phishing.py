#!/usr/bin/env python3
"""钓鱼集群监控探测脚本（准备阶段，后续可挂定时任务）。
目标集群: 59.110.23.95 (vote.sun-c.cn / sun-c.cn / bjxf315.com)
回传: 0c1a9f2o.pages.dev (Cloudflare 已拦截) | RDP 112.213.110.210:3389
OPSEC: 全部经 webshare 住宅代理，不暴露本机；低频率；只读。
用法: python tools/monitor_phishing.py [--cycle-min N]
  默认单次探测，输出 JSON 状态行。可被 cron/任务计划周期调用。
"""
import socket, base64, ssl, json, time, sys, os, datetime

CLASH=("127.0.0.1", 7890)
WS_HOST="p.webshare.io"; WS_PORT=80
WS_PASS="j5c6hsgm707p"; WS_USER="uwlkamjv"
# 监控目标为中国站，用 CN 出口更贴近真实访问且不易被屏蔽
WS_USER_CN="uwlkamjv-CN-1"
BASE_DIR=os.path.dirname(os.path.abspath(__file__))
RESULT_LOG=os.path.join(BASE_DIR,"..","artifacts","monitor-state.jsonl")

def read_status(sock):
    data=b""
    while b"\r\n\r\n" not in data:
        d=sock.recv(4096)
        if not d: break
        data+=d
    return data

def http_status(url, user=WS_USER_CN, timeout=35):
    """经 webshare 代理，返回 HTTP 状态码或错误。仅单次 GET HEAD。"""
    try:
        scheme, rest = url.split("://",1)
        host = rest.split("/")[0]
        port = 443 if scheme=="https" else 80
        slash = rest.find("/")
        path = rest[slash:] if slash!=-1 else "/"
        s=socket.create_connection(CLASH, timeout=timeout)
        s.sendall(f"CONNECT {WS_HOST}:{WS_PORT} HTTP/1.1\r\nHost: {WS_HOST}:{WS_PORT}\r\n\r\n".encode())
        read_status(s)
        auth=base64.b64encode(f"{user}:{WS_PASS}".encode()).decode()
        s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: Basic {auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n".encode())
        r=read_status(s).split(b"\r\n")[0].decode()
        if b"200" not in r.encode():
            s.close(); return f"TUNNEL-{r.split()[1] if len(r.split())>1 else 'FAIL'}"
        sock = s if scheme=="http" else ssl.create_default_context().wrap_socket(s, server_hostname=host)
        sock.sendall(f"HEAD {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n".encode())
        resp=b""
        while True:
            d=sock.recv(8192)
            if not d: break
            resp+=d
        sock.close()
        code = resp.split(b"\r\n")[0].decode().split()[1] if resp else "NO-RESP"
        return code
    except Exception as e:
        return f"ERR:{type(e).__name__}"

def rdp_state(ip="112.213.110.210", port=3389, timeout=20):
    """单端口 TCP 探测 RDP 是否开放（经 clash，出口非本机）。"""
    try:
        s=socket.create_connection(CLASH, timeout=timeout)
        s.sendall(f"CONNECT {ip}:{port} HTTP/1.1\r\nHost: {ip}:{port}\r\n\r\n".encode())
        r=read_status(s).split(b"\r\n")[0].decode()
        if b"200" in r.encode():
            s.sendall(b"\x03\x00\x00\x13\x0e\xe0\x00\x00\x00\x00\x00\x01\x00\x08\x00\x03\x00\x00\x00")
            time.sleep(1.5); s.settimeout(4)
            try:
                b=s.recv(32)
                s.close()
                return "OPEN" if b[:1]==b"\x03" else "OPEN(banner-odd)"
            except Exception:
                s.close(); return "OPEN(no-banner)"
        s.close(); return "CLOSED/FILTERED"
    except Exception as e:
        return f"ERR:{type(e).__name__}"

def main():
    targets = [
        ("vote.sun-c.cn_home", "https://vote.sun-c.cn/"),
        ("vote.sun-c.cn_s",    "https://vote.sun-c.cn/s/"),
        ("bjxf315.com",        "http://bjxf315.com/"),
        ("pagesdev_backend",   "https://0c1a9f2o.pages.dev/"),
    ]
    row = {"ts": datetime.datetime.now().isoformat(), "exit_ip": None}
    # 出口 IP
    try:
        r=json.loads(http_status_get_json())
        if isinstance(r,str): row["exit_ip"]="ERR"
        else: row["exit_ip"]="轮转住宅IP"
    except: row["exit_ip"]="ERR"
    for name,url in targets:
        code = http_status(url)
        row[name] = code
        time.sleep(1)  # 低频，避免触警
    row["rdp_112.213.110.210_3389"] = rdp_state()
    line=json.dumps(row, ensure_ascii=False)
    print(line)
    with open(RESULT_LOG,"a",encoding="utf-8") as f:
        f.write(line+"\n")

def http_status_get_json():
    """获取出口 IP (简化)"""
    try:
        s=socket.create_connection(CLASH, timeout=20)
        s.sendall(f"CONNECT {WS_HOST}:{WS_PORT} HTTP/1.1\r\nHost: {WS_HOST}:{WS_PORT}\r\n\r\n".encode())
        read_status(s)
        auth=base64.b64encode(f"{WS_USER}:{WS_PASS}".encode()).decode()
        s.sendall(f"CONNECT ipinfo.io:443 HTTP/1.1\r\nHost: ipinfo.io:443\r\nProxy-Authorization: Basic {auth}\r\nProxy-Connection: Keep-Alive\r\n\r\n".encode())
        read_status(s)
        tls=ssl.create_default_context().wrap_socket(s, server_hostname="ipinfo.io")
        tls.sendall(b"GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nConnection: close\r\n\r\n")
        resp=b""
        while True:
            d=tls.recv(8192)
            if not d: break
            resp+=d
        tls.close()
        body=resp.decode(errors='ignore').split("\r\n\r\n",1)[-1]
        d=json.loads(body)
        return json.dumps({"ip":d.get("ip"),"city":d.get("city")})
    except Exception as e:
        return json.dumps({"err":str(e)})

if __name__=="__main__":
    main()
