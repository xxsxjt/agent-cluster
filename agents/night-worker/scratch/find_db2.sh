#!/bin/sh
ls -la /data/xxsx-api/new-api-data/ | head -20
echo "=== �������� ==="
cat /etc/systemd/system/xxsx-api.service 2>/dev/null | grep -iE "env|ExecStart" | head -10
ls /opt/xxsx-api/ 2>/dev/null | head -20
echo "=== db �ļ� ==="
find /data/xxsx-api/new-api-data -maxdepth 1 -type f | head -10
