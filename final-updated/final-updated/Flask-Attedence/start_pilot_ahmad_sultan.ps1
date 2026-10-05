$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$venvPython = Join-Path $scriptDir 'pilot_env\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    $venvPython = 'python'
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Starting Ahmad Sultan Pilot Testing (4 Employees Only)    " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Employees: Azeem, UMAIR, Mohsin, Azan"
Write-Host "Database:  attendance_ahmad_sultan.db"
Write-Host "Port:      http://localhost:5000"
Write-Host "------------------------------------------------------------"

& $venvPython pilot_ahmad_sultan.py
