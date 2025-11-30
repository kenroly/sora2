# Test PowerShell query to see what processes are found
$result = @()
$allProcs = Get-CimInstance Win32_Process

foreach ($proc in $allProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine) {
        $processName = $proc.Name
        if (($processName -like '*chrome*.exe' -or $processName -like '*chromium*.exe') -and 
            $cmdLine -like '*user-data-dir*' -and 
            $cmdLine -notlike '*Crashpad*' -and 
            $cmdLine -notlike '*Google*Chrome*User Data*' -and 
            $cmdLine -notlike '*AppData*Local*Google*' -and 
            $cmdLine -notlike '*--type=*') {
            
            $isAutomation = $false
            if ($cmdLine -match 'profiles' -or $cmdLine -match 'sora2' -or $cmdLine -match 'C:\\Users\\TheDat\\Documents\\sora2') {
                $isAutomation = $true
            } else {
                $userDataMatch = $cmdLine -match '--user-data-dir[=:]([^\s"]+)'
                if ($userDataMatch) {
                    $userDataDir = $matches[1]
                    if ($userDataDir -match 'profiles' -or $userDataDir -match 'sora2' -or $userDataDir -match 'C:\\Users\\TheDat\\Documents\\sora2') {
                        $isAutomation = $true
                    }
                }
            }
            
            if ($isAutomation) {
                $windowTitle = ''
                try {
                    $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
                    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
                        $windowTitle = $p.MainWindowTitle
                    }
                } catch {}
                
                Write-Host "Found process:"
                Write-Host "  PID: $($proc.ProcessId)"
                Write-Host "  Name: $processName"
                Write-Host "  Window: $windowTitle"
                Write-Host "  CommandLine: $($cmdLine.Substring(0, [Math]::Min(200, $cmdLine.Length)))"
                Write-Host "---"
                
                $result += @{
                    ProcessId = $proc.ProcessId
                    Name = $processName
                    CommandLine = $cmdLine
                    WindowTitle = $windowTitle
                }
            }
        }
    }
}

Write-Host ""
Write-Host "Total found: $($result.Count)"
if ($result.Count -eq 0) {
    Write-Host "No automation browser processes found!"
    Write-Host ""
    Write-Host "Checking all Chrome processes with user-data-dir:"
    foreach ($proc in $allProcs) {
        $cmdLine = $proc.CommandLine
        if ($cmdLine -and ($proc.Name -like '*chrome*.exe' -or $proc.Name -like '*chromium*.exe') -and $cmdLine -like '*user-data-dir*' -and $cmdLine -notlike '*Crashpad*' -and $cmdLine -notlike '*Google*Chrome*User Data*') {
            Write-Host "  PID: $($proc.ProcessId), Name: $($proc.Name)"
            Write-Host "    CommandLine: $($cmdLine.Substring(0, [Math]::Min(300, $cmdLine.Length)))"
            Write-Host ""
        }
    }
}


