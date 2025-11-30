# Check for any processes with profiles or sora2 in command line
$allProcs = Get-CimInstance Win32_Process
$found = @()

foreach ($proc in $allProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine -and ($cmdLine -match 'profiles' -or $cmdLine -match 'sora2' -or $cmdLine -match 'C:\\Users\\TheDat\\Documents\\sora2')) {
        $hasWindow = $false
        $windowTitle = ''
        try {
            $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
                $hasWindow = $true
                $windowTitle = $p.MainWindowTitle
            }
        } catch {}
        
        $found += @{
            PID = $proc.ProcessId
            Name = $proc.Name
            HasWindow = $hasWindow
            WindowTitle = $windowTitle
            CommandLine = $cmdLine
        }
    }
}

Write-Host "Found $($found.Count) processes with 'profiles' or 'sora2' in command line:"
Write-Host ""
foreach ($proc in $found) {
    Write-Host "PID: $($proc.PID), Name: $($proc.Name)"
    Write-Host "  Has Window: $($proc.HasWindow)"
    Write-Host "  Window Title: $($proc.WindowTitle)"
    if ($proc.CommandLine.Length -gt 500) {
        Write-Host "  CommandLine: $($proc.CommandLine.Substring(0, 500))..."
    } else {
        Write-Host "  CommandLine: $($proc.CommandLine)"
    }
    Write-Host ""
}

