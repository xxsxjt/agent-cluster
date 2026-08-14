#!/bin/bash
# genworld2.sh — generate a Terraria world with an isolated TShock config dir + scratch port.
# usage: genworld2.sh <worldname> <worldpath> <autocreate 1|2|3> <difficulty 0-3> <evil> <seed> <configdir> <port> <log>
# Never touches the live instance's config/sqlite/world. Stops the process after generation.
set -u
WNAME="$1"; WP="$2"; SIZE="$3"; DIFF="$4"; EVIL="$5"; SEED="$6"; CFGDIR="$7"; PORT="$8"; LOG="$9"

cd /data/terraria/tshock || exit 1

mkdir -p "$CFGDIR" "$(dirname "$LOG")"
# Minimal config: scratch port, no password, do NOT rename the world via ServerName.
cat > "$CFGDIR/config.json" <<EOF
{
  "Settings": {
    "ServerPort": $PORT,
    "ServerPassword": "",
    "MaxSlots": 2,
    "UseServerName": false,
    "AutoSave": false,
    "AnnounceSave": false,
    "BackupInterval": 0,
    "DisableSpewLogs": true,
    "LogPath": "$CFGDIR/logs",
    "SqliteDBPath": "$CFGDIR/tshock.sqlite"
  }
}
EOF
chown -R terraria:terraria "$CFGDIR"
rm -f "$LOG"; touch "$LOG"; chown terraria:terraria "$LOG"

runuser -u terraria -- env HOME=/data/terraria \
  DOTNET_BUNDLE_EXTRACT_BASE_DIR=/data/terraria/.net \
  XDG_CACHE_HOME=/data/terraria/.cache \
  ./TShock.Server -autocreate "$SIZE" -worldname "$WNAME" -world "$WP" \
  -difficulty "$DIFF" -worldevil "$EVIL" -seed "$SEED" \
  -configpath "$CFGDIR" -logpath "$CFGDIR/logs" -port "$PORT" >"$LOG" 2>&1 &
PID=$!
echo "pid=$PID  size=$SIZE diff=$DIFF evil=$EVIL port=$PORT"
echo "seed=[$SEED]"

PEAK=0
STATUS="TIMEOUT"
for i in $(seq 1 600); do
  sleep 2
  if [ -r "/proc/$PID/statm" ]; then
    RSS=$(( $(awk '{print $2}' "/proc/$PID/statm" 2>/dev/null || echo 0) * 4 / 1024 ))
    [ "$RSS" -gt "$PEAK" ] && PEAK=$RSS
  fi
  if grep -aqE "服务器已启动|Server started|Listening on tcp" "$LOG" 2>/dev/null; then
    STATUS="STARTED after $((i*2))s"; break
  fi
  if grep -aqE "Startup aborted|InvalidOperationException|Unhandled exception|Failure processing|Invalid value given" "$LOG" 2>/dev/null; then
    STATUS="ERROR after $((i*2))s"; break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then STATUS="PROCESS EXITED after $((i*2))s"; break; fi
done
echo "status=$STATUS  peakRSS=${PEAK}MiB"

echo "=== key log lines ==="
grep -aE "Creating world|Evil:|Difficulty:|Seed:|服务器已启动|Server started|Error|Exception|aborted|Invalid|无效" "$LOG" | head -25

if kill -0 "$PID" 2>/dev/null; then
  echo "=== SIGTERM -> graceful stop ==="
  kill -TERM "$PID"
  for i in $(seq 1 60); do sleep 1; kill -0 "$PID" 2>/dev/null || { echo "exited in ${i}s"; break; }; done
  if kill -0 "$PID" 2>/dev/null; then echo "force kill PID $PID"; kill -9 "$PID"; sleep 2; fi
fi

echo "=== world file ==="
ls -l "$WP" 2>/dev/null || echo "WORLD FILE MISSING"
