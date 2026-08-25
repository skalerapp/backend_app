param(
    [switch]$Apply,
    [switch]$Client,
    [int]$AttendanceId = 0,
    [string]$From = "",
    [string]$To = ""
)

$ErrorActionPreference = "Stop"
$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $backendRoot "..")

$argsList = @()
if ($Apply) { $argsList += "--apply" }
if ($Client) { $argsList += "--client" }
if ($AttendanceId -gt 0) { $argsList += @("--id", "$AttendanceId") }
if (-not [string]::IsNullOrWhiteSpace($From)) { $argsList += @("--from", $From) }
if (-not [string]::IsNullOrWhiteSpace($To)) { $argsList += @("--to", $To) }

Write-Host ""
Write-Host "Recalculo de productividad de asistencia" -ForegroundColor Cyan
if ($Client) {
    Write-Host "Modo cliente/produccion (.env.client.sync)" -ForegroundColor Yellow
} else {
    Write-Host "Modo local (.env). Para Railway usa -Client" -ForegroundColor Yellow
}
if (-not $Apply) {
    Write-Host "Simulacion (usa -Apply para escribir en BD)" -ForegroundColor Yellow
}

npm run migrate:attendance:recalc-productivity -- @argsList
