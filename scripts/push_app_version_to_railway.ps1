param(
    [string]$RepoUrl = "https://github.com/skalerapp/backend_app.git",
    [string]$WorkDir = ""
)

$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ([string]::IsNullOrWhiteSpace($WorkDir)) {
    $WorkDir = Join-Path $env:TEMP "backend_app-deploy"
}

Write-Host ""
Write-Host "Sincronizar /api/app/version -> skalerapp/backend_app" -ForegroundColor Cyan
Write-Host "Origen local: $backendRoot"
Write-Host "Destino git:  $WorkDir"
Write-Host ""

if (-not (Test-Path (Join-Path $backendRoot "src\modules\app\app.routes.js"))) {
    Write-Host "No se encontro el modulo app en el backend local." -ForegroundColor Red
    exit 1
}

if (Test-Path $WorkDir) {
    Write-Host "Actualizando clone existente..."
    Set-Location $WorkDir
    git fetch origin
    git checkout main
    git pull origin main
} else {
    Write-Host "Clonando repo..."
    git clone $RepoUrl $WorkDir
    Set-Location $WorkDir
}

$destModules = Join-Path $WorkDir "src\modules\app"
New-Item -ItemType Directory -Force -Path $destModules | Out-Null

Copy-Item (Join-Path $backendRoot "src\modules\app\app.controller.js") $destModules -Force
Copy-Item (Join-Path $backendRoot "src\modules\app\app.routes.js") $destModules -Force
Copy-Item (Join-Path $backendRoot "src\server.js") (Join-Path $WorkDir "src\server.js") -Force
Copy-Item (Join-Path $backendRoot "src\modules\warehouse\warehouse.service.js") (Join-Path $WorkDir "src\modules\warehouse\warehouse.service.js") -Force

$testFile = Join-Path $backendRoot "test\app.version.test.js"
if (Test-Path $testFile) {
    New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir "test") | Out-Null
    Copy-Item $testFile (Join-Path $WorkDir "test\app.version.test.js") -Force
}

git add src/modules/app src/server.js src/modules/warehouse/warehouse.service.js test/app.version.test.js 2>$null
git add src/modules/app src/server.js src/modules/warehouse/warehouse.service.js

$status = git status --porcelain
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host ""
    Write-Host "Sin cambios: backend_app ya tiene el codigo de version." -ForegroundColor Yellow
    Write-Host "En Railway: Deployments -> Redeploy"
    exit 0
}

Write-Host ""
Write-Host "Cambios a publicar:" -ForegroundColor Green
git status --short

if (-not (git config user.email)) {
    git config user.email "293231825+skalerapp@users.noreply.github.com"
}
if (-not (git config user.name)) {
    git config user.name "skalerapp"
}

git commit -m "Add app version endpoint and fix warehouse schema migration for MySQL"

Write-Host ""
Write-Host "Publicando en GitHub (Railway despliega automaticamente)..." -ForegroundColor Cyan
git push origin main

Write-Host ""
Write-Host "Listo. Espera 1-2 min y verifica:" -ForegroundColor Green
Write-Host "  .\frontend\flutter\scripts\validate_client_backend.ps1 -ApiBaseUrl `"https://backendapp-production-286f.up.railway.app/api`""
