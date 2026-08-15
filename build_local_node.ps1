$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeUiDir = Join-Path $Root "local_node\local_node_ui"
$VenvPython = Join-Path $Root "venv\Scripts\python.exe"

Write-Host "QIntellect Attendance Node build" -ForegroundColor Cyan
Write-Host "Repo root: $Root"

if (!(Test-Path $VenvPython)) {
  throw "Python virtual environment was not found at $VenvPython. Activate or create the root venv first."
}

if (!(Test-Path $NodeUiDir)) {
  throw "local_node\local_node_ui was not found at $NodeUiDir."
}

Write-Host "Checking Python build dependencies..." -ForegroundColor Yellow
& $VenvPython -c "import onnxruntime, insightface"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Repairing onnxruntime / numpy in the root venv..." -ForegroundColor Yellow
  & $VenvPython -m pip install --force-reinstall numpy==1.26.4 onnxruntime==1.17.0
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to repair the Python build environment."
  }
}

Push-Location $Root
try {
  Write-Host "Building local node UI..." -ForegroundColor Yellow
  Push-Location $NodeUiDir
  try {
    npm run build
  }
  finally {
    Pop-Location
  }

  Write-Host "Priming InsightFace models..." -ForegroundColor Yellow
  & $VenvPython -m local_node.scripts.prime_models

  if ($LASTEXITCODE -ne 0) {
    throw "Model priming failed. Fix the Python environment or onnxruntime installation, then rerun the build."
  }

  Write-Host "Building standalone local node installer..." -ForegroundColor Yellow
  & $VenvPython -m local_node.build.build

  if ($LASTEXITCODE -ne 0) {
    throw "Local node build failed."
  }
}
finally {
  Pop-Location
}

Write-Host "Build completed successfully." -ForegroundColor Green