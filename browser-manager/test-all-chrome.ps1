# List all Chrome processes
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*chrome*.exe' -or $_.Name -like '*chromium*.exe' }

Write-Host "Total Chrome processes: $($procs.Count)"
Write-Host ""

foreach ($proc in $procs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine) {
        $hasWindow = $false
        $windowTitle = ''
        try {
            $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
                $hasWindow = $true
                $windowTitle = $p.MainWindowTitle
            }
        } catch {}
        
        Write-Host "PID: $($proc.ProcessId), Name: $($proc.Name)"
        Write-Host "  Has Window: $hasWindow"
        Write-Host "  Window Title: $windowTitle"
        if ($cmdLine.Length -gt 400) {
            Write-Host "  CommandLine: $($cmdLine.Substring(0, 400))..."
        } else {
            Write-Host "  CommandLine: $cmdLine"
        }
        Write-Host ""
    }
}

