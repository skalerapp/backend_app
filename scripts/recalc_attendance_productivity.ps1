param(
    [switch]$Apply,
    [int]$AttendanceId = 0,
    [string]$From = "",
    [string]$To = ""
)

$ErrorActionPreference = "Stop"
$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $backendRoot "..")

$argsList = @()
if ($Apply) { $argsList += "--apply" }
if ($AttendanceId -gt 0) { $argsList += @("--id", "$AttendanceId") }
if (-not [string]::IsNullOrWhiteSpace($From)) { $argsList += @("--from", $From) }
if (-not [string]::IsNullOrWhiteSpace($To)) { $argsList += @("--to", $To) }

Write-Host ""
Write-Host "Recalculo de productividad de asistencia" -ForegroundColor Cyan
if (-not $Apply) {
    Write-Host "Modo simulacion (usa -Apply para escribir en BD)" -ForegroundColor Yellow
}

npm run migrate:attendance:recalc-productivity -- @argsList
