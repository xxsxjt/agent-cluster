#!/bin/sh
ls /data/xxsx-api/ 2>/dev/null | head -30
echo "=== new-api ���� ==="
ls /data/xxsx-api/*/ 2>/dev/null | grep -iE "config|env|docker" | head -20
find /data/xxsx-api -maxdepth 2 -name "*.env*" -o -maxdepth 2 -name "docker-compose*.yml" -o -maxdepth 2 -name "config*.json" 2>/dev/null | head -10
echo "=== ���� ==="
ps aux 2>/dev/null | grep -iE "new-api|one-api" | grep -v grep | head -5
