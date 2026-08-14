#!/usr/bin/env python3
"""
作品集本地服务器
用法：python portfolio-server.py [port]
默认端口：8080
"""

import http.server
import socketserver
import os
import webbrowser
from pathlib import Path

PORT = 8080
DIRECTORY = Path(__file__).parent / "deploy"

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIRECTORY), **kwargs)
    
    def end_headers(self):
        # 添加 CORS 头
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

def main():
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    
    # 确保 deploy 目录存在
    if not DIRECTORY.exists():
        print(f"错误：deploy 目录不存在：{DIRECTORY}")
        print("请先运行：node automation/deploy-portfolio.js quick")
        return
    
    os.chdir(DIRECTORY)
    
    with socketserver.TCPServer(("", port), Handler) as httpd:
        url = f"http://localhost:{port}"
        print(f"=" * 50)
        print(f"  Agnes AI 作品集服务器")
        print(f"=" * 50)
        print(f"  本地地址：{url}")
        print(f"  目录：{DIRECTORY}")
        print(f"=" * 50)
        print(f"  按 Ctrl+C 停止")
        print(f"=" * 50)
        
        # 自动打开浏览器
        try:
            webbrowser.open(url)
        except:
            pass
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")

if __name__ == "__main__":
    main()
