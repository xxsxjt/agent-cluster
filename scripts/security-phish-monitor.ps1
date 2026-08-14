# security phishing-cluster monitor cron wrapper (2026-08-10)
# Calls tools/monitor_phishing.py via webshare residential proxy, appends artifacts/monitor-state.jsonl
# Deps: local clash(127.0.0.1:7890) up + webshare creds (embedded in script)
# Trigger: Windows task org-security-phish-monitor (every 30 min)
# OPSEC: all via webshare residential rotating proxy, exit non-local; read-only probes
$ErrorActionPreference = "Continue"
$base = "C:\Users\du_ji\pi_workspace\org\agents\security"
$py   = "C:\Users\du_ji\AppData\Local\Programs\Python\Python314\python.exe"
$log  = "$base\logs\monitor-cron.log"
$ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# 1) pre-check: clash(7890) must be up (script needs proxy egress)
$clashUp = $false
try {
    $tcp = New-Object Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 7890)
    $clashUp = $true
    $tcp.Close()
} catch { $clashUp = $false }

if (-not $clashUp) {
    Add-Content -Path $log -Value "$ts SKIP clash(7890) down, no proxy egress, skip round to avoid direct IP" -Encoding utf8
    exit 0
}

# 2) run monitor script
$out = & $py "$base\tools\monitor_phishing.py" 2>&1
Add-Content -Path $log -Value "$ts RUN $out" -Encoding utf8

# 3) failure trace
if ($LASTEXITCODE -ne 0) {
    $errLine = "$ts ERROR exit=$LASTEXITCODE $out"
    Add-Content -Path $log -Value $errLine -Encoding utf8
}
exit $LASTEXITCODE
