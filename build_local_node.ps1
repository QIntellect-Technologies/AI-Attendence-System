$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeUiDir = Join-Path $Root "local_node\local_node_ui"
$VenvPython = Join-Path $Root "venv-node\Scripts\python.exe"

Write-Host "QIntellect Attendance Node build" -ForegroundColor Cyan
Write-Host "Repo root: $Root"

if (!(Test-Path $VenvPython)) {
    throw "Node build virtual environment was not found at $VenvPython. Create venv-node first (GPU onnxruntime)."
}

if (!(Test-Path $NodeUiDir)) {
  throw "local_node\local_node_ui was not found at $NodeUiDir."
}

# insightface ka wheel apni data_files ko venv ki jad mein rakh deta hai,
# jabke asal package lib\site-packages mein hota hai. Nuitka dono ko ek hi
# module samajh kar "duplicate locals name" par crash kar jata hai.
$StrayInsightface = Join-Path $Root "venv-node\insightface"
if (Test-Path $StrayInsightface) {
  Write-Host "Removing stray insightface data_files copy from venv root..." -ForegroundColor Yellow
  Remove-Item $StrayInsightface -Recurse -Force
}

Write-Host "Checking Python build dependencies..." -ForegroundColor Yellow
& $VenvPython -c "import onnxruntime, insightface, skimage"
if ($LASTEXITCODE -ne 0) {
  throw "Build venv is missing onnxruntime / insightface / scikit-image. Install local_node\requirements.txt into venv-node - do not let the build mutate package versions."
}

Write-Host "Build environment versions:" -ForegroundColor Yellow
& $VenvPython -c "import insightface, onnxruntime, numpy, skimage; print('insightface', insightface.__version__, '| onnxruntime', onnxruntime.__version__, '| numpy', numpy.__version__, '| skimage', skimage.__version__)"

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