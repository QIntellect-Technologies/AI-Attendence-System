$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path (Join-Path $scriptDir 'logs'))) {
    New-Item -ItemType Directory -Path (Join-Path $scriptDir 'logs') -Force | Out-Null
}

$pythonExe = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $pythonExe = 'py'
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonExe = 'python'
}
else {
    throw 'Python 3.10 was not found on this machine. Please install Python 3.10 first.'
}

$venvDir = Join-Path $scriptDir 'pilot_env'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    Write-Host 'Creating pilot environment...'
    & $pythonExe -3.10 -m venv $venvDir
}

if (-not (Test-Path $venvPython)) {
    throw 'Failed to create pilot environment.'
}

Write-Host 'Installing dependencies once...'
& $venvPython -m pip install --upgrade pip | Out-Null
& $venvPython -m pip install -r (Join-Path $scriptDir 'requirements.txt') | Out-Null

$logOut = Join-Path $scriptDir 'logs\pilot_stdout.log'
$logErr = Join-Path $scriptDir 'logs\pilot_stderr.log'

$existing = Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -First 1
if ($null -ne $existing) {
    Write-Host 'Port 5000 is already in use. Using the existing app instance.'
    Start-Process "http://127.0.0.1:5000"
    exit 0
}

Write-Host 'Starting attendance pilot app...'
$process = Start-Process -FilePath $venvPython -ArgumentList 'app.py' -WorkingDirectory $scriptDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr

Start-Sleep -Seconds 8
$browserUrl = 'http://127.0.0.1:5000'
try {
    $response = Invoke-WebRequest -Uri $browserUrl -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "Pilot app is ready at $browserUrl"
        Start-Process $browserUrl
    }
}
catch {
    Write-Host "The app may still be starting. Please check $logOut for details."
    Start-Process $browserUrl
}
