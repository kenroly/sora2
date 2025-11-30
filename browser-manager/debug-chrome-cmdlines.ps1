# Debug: Show Chrome processes with user-data-dir
$procs = Get-CimInstance Win32_Process | Where-Object { 
    ($_.Name -like '*chrome*.exe' -or $_.Name -like '*chromium*.exe') -and 
    $_.CommandLine -notlike '*--type=*' -and 
    $_.CommandLine -like '*user-data-dir*'
}

Write-Host "Found $($procs.Count) Chrome main processes with user-data-dir:"
Write-Host ""

foreach ($proc in $procs) {
    $cmdLine = $proc.CommandLine
    $hasWindow = $false
    $windowTitle = ''
    
    try {
        $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
            $hasWindow = $true
            $windowTitle = $p.MainWindowTitle
        }
    } catch {}
    
    Write-Host "PID: $($proc.ProcessId), Has Window: $hasWindow"
    if ($hasWindow) {
        Write-Host "  Window: $windowTitle"
    }
    
    # Extract user-data-dir using simple string operations
    $userDataDir = ''
    if ($cmdLine -match '--user-data-dir') {
        $parts = $cmdLine -split '--user-data-dir'
        if ($parts.Length -gt 1) {
            $value = $parts[1].Trim()
            if ($value.StartsWith('=')) {
                $value = $value.Substring(1).Trim()
            }
            if ($value.StartsWith('"')) {
                $endQuote = $value.IndexOf('"', 1)
                if ($endQuote -gt 0) {
                    $userDataDir = $value.Substring(1, $endQuote - 1)
                }
            } else {
                $spaceIndex = $value.IndexOf(' ')
                if ($spaceIndex -gt 0) {
                    $userDataDir = $value.Substring(0, $spaceIndex)
                } else {
                    $userDataDir = $value
                }
            }
        }
    }
    
    if ($userDataDir) {
        Write-Host "  user-data-dir: $userDataDir"
        
        # Check if it matches profiles
        if ($userDataDir -like '*profiles*') {
            Write-Host "  Contains profiles"
            if ($userDataDir -like '*profiles\*' -or $userDataDir -like '*profiles/*') {
                $profileParts = $userDataDir -split '[\\/]'
                $profileIndex = -1
                for ($i = 0; $i -lt $profileParts.Length; $i++) {
                    if ($profileParts[$i] -eq 'profiles') {
                        $profileIndex = $i
                        break
                    }
                }
                if ($profileIndex -ge 0 -and $profileIndex -lt ($profileParts.Length - 1)) {
                    Write-Host "  Profile: $($profileParts[$profileIndex + 1])"
                }
            }
        } else {
            Write-Host "  Does NOT contain profiles"
        }
    } else {
        Write-Host "  Could not extract user-data-dir"
    }
    
    Write-Host "  CommandLine (first 600 chars):"
    $displayCmd = $cmdLine
    if ($displayCmd.Length -gt 600) {
        $displayCmd = $displayCmd.Substring(0, 600) + "..."
    }
    Write-Host $displayCmd
    Write-Host ""
}
