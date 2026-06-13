param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile,

    [switch]$SkipBackupReminder
)

$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $backendRoot

$envPath = Join-Path $backendRoot $EnvFile
if (-not (Test-Path $envPath)) {
    Write-Host "No existe el archivo: $envPath" -ForegroundColor Red
    Write-Host "Crea uno con DATABASE_URL del MySQL del cliente (no lo subas a Git)." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Sincronizacion de schema SKALER (produccion)" -ForegroundColor Cyan
Write-Host "Archivo env: $envPath" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipBackupReminder) {
    Write-Host "IMPORTANTE: haz backup de MySQL del cliente antes de continuar." -ForegroundColor Yellow
    Write-Host "Ver documentation/DB_UPDATE_PRODUCTION.md" -ForegroundColor Yellow
    $confirm = Read-Host "Escriba SI para continuar"
    if ($confirm -ne "SI") {
        Write-Host "Cancelado." -ForegroundColor Yellow
        exit 0
    }
}

Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -lt 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"')
    [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL) -and [string]::IsNullOrWhiteSpace($env:MYSQLHOST)) {
    Write-Host "El archivo env debe definir DATABASE_URL o MYSQLHOST/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE" -ForegroundColor Red
    exit 1
}

Write-Host "Ejecutando npm run db:schema:sync ..." -ForegroundColor Cyan
npm run db:schema:sync

if ($LASTEXITCODE -ne 0) {
    Write-Host "Sync fallo. Revisa el log arriba." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Schema sincronizado. Prueba login y modulos clave en el backend del cliente." -ForegroundColor Green
