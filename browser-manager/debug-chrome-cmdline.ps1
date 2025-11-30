# Debug script to see actual Chrome command lines
# Run this while browser is launched from orchestrator

Write-Host "=== All Chrome Processes with Command Lines ==="
Write-Host ""

$allProcs = Get-CimInstance Win32_Process | Where-Object { 
    $_.Name -like '*chrome*.exe' -or $_.Name -like '*chromium*.exe' 
}

$count = 0
foreach ($proc in $allProcs) {
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
        
        $count++
        Write-Host "[$count] PID: $($proc.ProcessId), Name: $($proc.Name)"
        Write-Host "     Has Window: $hasWindow"
        if ($hasWindow) {
            Write-Host "     Window Title: $windowTitle"
        }
        Write-Host "     Is Main Process: $($cmdLine -notlike '*--type=*')"
        Write-Host "     Has user-data-dir: $($cmdLine -like '*user-data-dir*')"
        
        # Check if it matches our criteria
        $matchesProfiles = $cmdLine -match 'profiles' -or $cmdLine -match 'sora2' -or $cmdLine -match 'C:\\Users\\TheDat\\Documents\\sora2'
        Write-Host "     Matches profiles/sora2: $matchesProfiles"
        
        # Extract user-data-dir if present
        if ($cmdLine -match '--user-data-dir[=:]"?([^"\\s]+)"?' -or $cmdLine -match '--user-data-dir[=:]([^\\s]+)') {
            $userDataDir = $matches[1]
            Write-Host "     user-data-dir: $userDataDir"
        }
        
        Write-Host "     CommandLine (first 500 chars):"
        if ($cmdLine.Length -gt 500) {
            Write-Host "       $($cmdLine.Substring(0, 500))..."
        } else {
            Write-Host "       $cmdLine"
        }
        Write-Host ""
    }
}

Write-Host "Total Chrome processes found: $count"

