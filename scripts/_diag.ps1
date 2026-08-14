$errs = @()
$tokens = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'C:\Users\du_ji\pi_workspace\org\scripts\org-watchdog.ps1' -Raw -Encoding UTF8), [ref]$errs)
foreach ($e in $errs) {
    "LINE $($e.Token.StartLine) COL $($e.Token.StartColumn): $($e.Message)"
}
