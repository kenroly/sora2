# Browser detection script for sora-worker browsers
# Strategy: Find Chrome main processes (with windows) that have user-data-dir in profiles/
# Don't show Worker.exe directly - only show the Chrome browser windows

$result = @()
$allProcs = Get-CimInstance Win32_Process

# First, collect Worker.exe PIDs to find their Chrome children
$workerPids = @()
foreach ($proc in $allProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine) {
        $processName = $proc.Name
        if (($processName -like '*Worker.exe' -or $processName -like '*FastExecuteScript*.exe') -and
            ($cmdLine -match '\.fingerprint-engine' -or $cmdLine -match 'sora2')) {
            $workerPids += $proc.ProcessId
        }
    }
}

# Now find Chrome main processes (with windows) that have user-data-dir in profiles/
foreach ($proc in $allProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine) {
        $processName = $proc.Name
        $windowTitle = ''
        $hasWindow = $false
        
        try {
            $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
                $windowTitle = $p.MainWindowTitle
                $hasWindow = $true
            }
        } catch {}
        
        # Show Chrome main processes that have user-data-dir in profiles/
        # Don't require window - browser might be launching
        if (($processName -like '*chrome*.exe' -or $processName -like '*chromium*.exe') -and 
            $cmdLine -notlike '*--type=*' -and 
            $cmdLine -notlike '*Crashpad*' -and
            $cmdLine -like '*user-data-dir*') {
            
            # Extract user-data-dir using multiple methods
            $userDataDir = ''
            
            # Method 1: Try quoted path
            if ($cmdLine -match '--user-data-dir[=:]"([^"]+)"') {
                $userDataDir = $matches[1]
            }
            # Method 2: Try unquoted path
            elseif ($cmdLine -match '--user-data-dir[=:]([^\s]+)') {
                $userDataDir = $matches[1]
            }
            # Method 3: Try with equals sign
            elseif ($cmdLine -match '--user-data-dir="([^"]+)"') {
                $userDataDir = $matches[1]
            }
            elseif ($cmdLine -match '--user-data-dir=([^\s]+)') {
                $userDataDir = $matches[1]
            }
            
            # MUST have user-data-dir in profiles/ or sora2 directory
            $isAutomation = $false
            if ($userDataDir) {
                # Normalize path separators for matching
                $normalized = $userDataDir -replace '\\', '/'
                if ($normalized -match 'profiles/([^/]+)' -or 
                    $normalized -match 'sora2/profiles/([^/]+)') {
                    $isAutomation = $true
                }
            }
            
            # Also check command line directly if user-data-dir extraction failed
            if (-not $isAutomation) {
                $normalizedCmd = $cmdLine -replace '\\', '/'
                if ($normalizedCmd -match 'profiles/([^/\s]+)' -or
                    $normalizedCmd -match 'sora2/profiles/([^/\s]+)') {
                    $isAutomation = $true
                }
            }
            
            if ($isAutomation) {
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

if ($result.Count -eq 0) {
    Write-Host '[]'
} else {
    $result | ConvertTo-Json -Depth 2
}

