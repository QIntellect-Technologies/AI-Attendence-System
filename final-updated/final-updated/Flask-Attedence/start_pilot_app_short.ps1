$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$shortDir = 'C:\pilot-app'

if (-not (Test-Path $shortDir)) {
    New-Item -ItemType Directory -Path $shortDir -Force | Out-Null
}

Copy-Item (Join-Path $scriptDir '*') $shortDir -Recurse -Force

$pythonExe = 'py'
$venvDir = Join-Path $shortDir 'pilot_env'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'

if (-not (Test-Path $venvPython)) {
    & $pythonExe -3.10 -m venv $venvDir
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $shortDir 'requirements.txt')

Set-Location $shortDir
Start-Process -FilePath $venvPython -ArgumentList 'app.py' -WorkingDirectory $shortDir -WindowStyle Hidden
Start-Sleep -Seconds 8
Start-Process 'http://127.0.0.1:5000'
