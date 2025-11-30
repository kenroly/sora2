Param(
    [string]$EngineRoot = "C:\app\.fingerprint-engine",
    [string]$ProjectPath = "C:\app\node_modules\browser-with-fingerprints\project.xml"
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $ProjectPath)) {
    throw "Browser-with-fingerprints project file not found at $ProjectPath"
}

Write-Host "Preparing fingerprint engine in $EngineRoot"

New-Item -ItemType Directory -Force -Path $EngineRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $EngineRoot 'logs') | Out-Null

$projectContent = Get-Content $ProjectPath -Raw
$match = [regex]::Match($projectContent, '<EngineVersion>([0-9\.]+)</EngineVersion>')
if (-not $match.Success) {
    throw "Unable to detect EngineVersion from project.xml"
}

$version = $match.Groups[1].Value
$arch = if ([Environment]::Is64BitOperatingSystem) { '64' } else { '32' }

Write-Host "Detected engine version $version (x$arch)"

$metaUrl = "http://bablosoft.com/distr/FastExecuteScript$arch/$version/FastExecuteScript.x$arch.zip.meta.json"
$metaPath = Join-Path $EngineRoot ("{0}_{1}.json" -f $version, $arch)
Invoke-WebRequest -UseBasicParsing -Uri $metaUrl -OutFile $metaPath
$meta = Get-Content $metaPath | ConvertFrom-Json

$engineVersionDir = Join-Path (Join-Path $EngineRoot 'engine') $version
$scriptVersionDir = Join-Path (Join-Path $EngineRoot 'script') $version
New-Item -ItemType Directory -Force -Path $engineVersionDir | Out-Null
New-Item -ItemType Directory -Force -Path $scriptVersionDir | Out-Null

$zipName = "FastExecuteScript.x$arch.zip"
$zipPath = Join-Path $engineVersionDir $zipName

if (-not (Test-Path $zipPath)) {
    Write-Host "Downloading engine package from $($meta.Url)"
    Invoke-WebRequest -UseBasicParsing -Uri $meta.Url -OutFile $zipPath
}
else {
    Write-Host "Reusing cached engine archive $zipPath"
}

Expand-Archive -Path $zipPath -DestinationPath $scriptVersionDir -Force

Copy-Item $ProjectPath -Destination (Join-Path $scriptVersionDir 'project.xml') -Force
Set-Content -Path (Join-Path $scriptVersionDir 'worker_command_line.txt') -Value '--mock-connector'
Set-Content -Path (Join-Path $scriptVersionDir 'settings.ini') -Value 'RunProfileRemoverImmediately=true'
Set-Content -Path (Join-Path $EngineRoot 'not_first_run.txt') -Value '1'

Write-Host "Fingerprint engine prepared successfully"

