# Actualiza variables de versionado 1.0.7 en Railway (requiere: railway login previo).
# Uso desde D:\Apps\Skaler\backend:
#   npm exec @railway/cli -- login
#   npm exec @railway/cli -- link   # selecciona proyecto backend_app
#   .\scripts\set_railway_vars_v1_0_7.ps1

$ErrorActionPreference = "Stop"

$vars = @{
    "APP_VERSION_CHECK_ENABLED"       = "true"
    "APP_LATEST_VERSION"              = "1.0.7"
    "APP_LATEST_BUILD_NUMBER"         = "8"
    "APP_MIN_VERSION"                 = "1.0.6"
    "APP_MIN_BUILD_NUMBER"            = "7"
    "APP_ANDROID_DOWNLOAD_URL"        = "https://github.com/skalerapp/skaler-app-updates/releases/download/v1.0.7/Skaler-1-0-7.apk"
    "APP_GITHUB_RELEASES_URL"         = "https://github.com/skalerapp/skaler-app-updates/releases/latest"
    "APP_RELEASE_NOTES"               = "Términos v2, login web, remisiones de despacho, inventario exportable, pie con versión en web y correcciones de almacén."
    "APP_TERMS_COMPANY_LEGAL_NAME"    = "SKALER S.A.S."
    "APP_TERMS_COMPANY_NIT"           = "900.225.517-7"
    "APP_TERMS_COMPANY_CITY"          = "Cali, Valle del Cauca, Colombia"
    "APP_TERMS_COMPANY_ADDRESS"       = "Calle 66 # 1N-66, Sector Industrial Calima, Cali"
    "APP_TERMS_COMPANY_WEBSITE"       = "https://www.skaler.com.co"
    "APP_TERMS_PRIVACY_CONTACT_EMAIL" = "comercialymarketing@skaler.com.co"
    "APP_TERMS_COMPANY_PHONE"         = "(+57) 602 447 3636"
    "APP_WEB_PASSWORD_LOGIN_ENABLED"  = "true"
}

Write-Host "Actualizando variables Railway para SKALER v1.0.7..." -ForegroundColor Cyan

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
