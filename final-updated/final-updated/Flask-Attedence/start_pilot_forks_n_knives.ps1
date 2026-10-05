$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$venvPython = Join-Path $scriptDir 'pilot_env\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    $venvPython = 'python'
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Starting Forks N Knives Pilot  (5 Employees Only)        " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Employees: Sikander, Shahid Assistant Chef, Salman, Shoaib, Siddique"
Write-Host "Database:  attendance_forks_n_knives.db"
Write-Host "Port:      http://localhost:5000"
Write-Host "------------------------------------------------------------"

& $venvPython pilot_forks_n_knives.py
