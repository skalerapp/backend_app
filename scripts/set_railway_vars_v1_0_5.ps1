# Actualiza variables de versionado 1.0.5 en Railway (requiere: railway login previo).
# Uso desde D:\Apps\Skaler\backend:
#   npm exec @railway/cli -- login
#   npm exec @railway/cli -- link   # selecciona proyecto backend_app
#   .\scripts\set_railway_vars_v1_0_5.ps1

$ErrorActionPreference = "Stop"

$vars = @{
    "APP_VERSION_CHECK_ENABLED"   = "true"
    "APP_LATEST_VERSION"            = "1.0.5"
    "APP_LATEST_BUILD_NUMBER"       = "6"
    "APP_MIN_VERSION"               = "1.0.4"
    "APP_MIN_BUILD_NUMBER"          = "5"
    "APP_ANDROID_DOWNLOAD_URL"      = "https://github.com/skalerapp/skaler-app-updates/releases/download/v1.0.5/Skaler-1-0-5.apk"
    "APP_GITHUB_RELEASES_URL"       = "https://github.com/skalerapp/skaler-app-updates/releases/latest"
    "APP_RELEASE_NOTES"             = "Retorno almacen multiple, HSE por proyecto, filtros dashboard comercial, export kardex/HSE, offline flota/HSE."
}

Write-Host "Actualizando variables Railway para SKALER v1.0.5..." -ForegroundColor Cyan

foreach ($entry in $vars.GetEnumerator()) {
    Write-Host "  $($entry.Key) = $($entry.Value)"
    npm exec --yes @railway/cli -- variables set "$($entry.Key)=$($entry.Value)" 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error al setear $($entry.Key). ¿Ejecutaste 'railway login' y 'railway link'?" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Variables actualizadas. Railway redeploya automaticamente." -ForegroundColor Green
Write-Host "Verifica en 1-2 min:"
Write-Host '  Invoke-RestMethod "https://backendapp-production-286f.up.railway.app/api/app/version"'
