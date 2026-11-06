# Helpers para invocar Railway CLI vía npm sin que PowerShell aborte por stderr (warnings deprecated).

function Invoke-RailwayNpm {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'

    try {
        $output = & npm exec --yes --loglevel=error @railway/cli @Arguments 2>&1
        foreach ($line in @($output)) {
            if ($null -eq $line) { continue }
            $text = $line.ToString()
            if ($text.Length -eq 0) { continue }
            if ($text -match 'npm warn deprecated') {
                Write-Host $text -ForegroundColor DarkYellow
            } elseif ($line -is [System.Management.Automation.ErrorRecord]) {
                Write-Host $line.Exception.Message -ForegroundColor Yellow
            } else {
                Write-Host $text
            }
        }
        return [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
}

function Set-RailwayVariable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    Write-Host "  $Key = $Value"
    $exitCode = Invoke-RailwayNpm -Arguments @('variables', 'set', "${Key}=${Value}")
    if ($exitCode -ne 0) {
        Write-Host "Error al setear $Key (exit $exitCode). ¿Ejecutaste 'npm exec @railway/cli -- login' y 'link' en este proyecto?" -ForegroundColor Red
        exit 1
    }
}
