#!/bin/bash
DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo "== tokens table =="
sqlite3 "$DB" ".tables" | tr ' ' '\n' | grep -i token
sqlite3 "$DB" "SELECT id, user_id, name, status, key FROM tokens WHERE user_id=1 AND status=1 LIMIT 5;" 2>&1 | head -5
echo "== options admin =="
sqlite3 "$DB" "SELECT id, key, value FROM options WHERE key LIKE '%chat%' LIMIT 5;" 2>&1 | head -5