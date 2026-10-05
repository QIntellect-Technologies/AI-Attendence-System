$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $Root "local_node"
$PythonExe = Join-Path $NodeDir ".venv\Scripts\python.exe"
Set-Location $NodeDir
& $PythonExe node_agent.py
