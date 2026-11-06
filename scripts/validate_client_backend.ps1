# Valida health, /app/version y opcionalmente login del backend en producción.
# El script canónico vive en frontend/flutter; este wrapper permite ejecutarlo desde backend\scripts.

param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBaseUrl,

    [string]$Email = "",
    [string]$Password = ""
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$flutterScript = Join-Path $repoRoot "frontend\flutter\scripts\validate_client_backend.ps1"

if (-not (Test-Path $flutterScript)) {
    Write-Host "No se encontró: $flutterScript" -ForegroundColor Red
    exit 1
}

& $flutterScript -ApiBaseUrl $ApiBaseUrl -Email $Email -Password $Password
exit $LASTEXITCODE
