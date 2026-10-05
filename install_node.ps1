<#
install_node.ps1
───────────────────────────────────────────────────────────────────────────────
Installs and activates the QIntellect Attendance Node on a Windows laptop.

Usage:
  Right click PowerShell → Run as Administrator
  cd extracted-installer-folder
  .\install_node.ps1

Optional:
  .\install_node.ps1 -RegisterTask
#>

param(
  [switch]$RegisterTask,
  [switch]$NoRunNow
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $Root "local_node"
$VenvDir = Join-Path $NodeDir ".venv"
$PythonExe = Join-Path $VenvDir "Scripts\python.exe"
$RunScript = Join-Path $Root "run_node.ps1"

Write-Host "QIntellect Attendance Node Installer" -ForegroundColor Cyan
Write-Host "Root: $Root"

if (!(Test-Path $NodeDir)) {
  throw "local_node folder was not found. Extract the ZIP completely before running installer."
}

if (!(Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python was not found. Install Python 3.10+ and enable 'Add Python to PATH'."
}

Push-Location $NodeDir
try {
  if (!(Test-Path $VenvDir)) {
    Write-Host "Creating Python virtual environment..."
    python -m venv .venv
  }

  Write-Host "Installing local node requirements..."
  & $PythonExe -m pip install --upgrade pip
  & $PythonExe -m pip install -r requirements.txt

  Write-Host "Activating node with backend..."
  & $PythonExe activate_node.py --config (Join-Path $NodeDir "node_install_config.json") --node-dir $NodeDir

  if ($LASTEXITCODE -ne 0) {
    throw "Node activation failed. Check the error above."
  }
}
finally {
  Pop-Location
}

Write-Host "Creating run_node.ps1..."
@"
`$ErrorActionPreference = "Stop"
`$Root = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$NodeDir = Join-Path `$Root "local_node"
`$PythonExe = Join-Path `$NodeDir ".venv\Scripts\python.exe"
Set-Location `$NodeDir
& `$PythonExe node_agent.py
"@ | Set-Content -Path $RunScript -Encoding UTF8

if ($RegisterTask) {
  Write-Host "Registering Windows Scheduled Task..."
  $TaskName = "QIntellect Attendance Node"
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$RunScript`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null
  Write-Host "Scheduled Task registered: $TaskName" -ForegroundColor Green
}

if (-not $NoRunNow) {
  Write-Host "Starting node agent..."
  Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$RunScript`"" -WorkingDirectory $Root
}

Write-Host "Installation completed successfully." -ForegroundColor Green
Write-Host "Config saved at: $(Join-Path $NodeDir 'node_config.json')"
