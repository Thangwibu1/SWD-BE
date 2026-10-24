[CmdletBinding()]
param([switch]$SkipBuild)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendDirectory = Split-Path -Parent $PSScriptRoot
$frontendDirectory = Join-Path (Split-Path -Parent $backendDirectory) 'architecture-evaluation-frontend'
$deploymentEnv = Join-Path $backendDirectory 'infra/deploy/deploy.env'
$deploymentExample = Join-Path $backendDirectory 'infra/deploy/deploy.env.example'
$composeFile = Join-Path $backendDirectory 'infra/deploy/compose.yaml'

if (-not (Test-Path -LiteralPath $deploymentEnv)) {
    Copy-Item -LiteralPath $deploymentExample -Destination $deploymentEnv
}
& docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before running this script.' }

# Only image tags and the public URL are needed by the launcher.
$deploymentValues = @{}
foreach ($line in Get-Content -LiteralPath $deploymentEnv) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
        $deploymentValues[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
}
$backendImage = $deploymentValues['BACKEND_IMAGE']
$sutImage = $deploymentValues['SUT_IMAGE']
$frontendImage = $deploymentValues['FRONTEND_IMAGE']
if (-not $backendImage -or -not $sutImage -or -not $frontendImage) {
    throw 'deploy.env must define BACKEND_IMAGE, SUT_IMAGE and FRONTEND_IMAGE.'
}

Push-Location $backendDirectory
try {
    & docker compose --env-file $deploymentEnv -f $composeFile config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Compose configuration is invalid.' }
    if (-not $SkipBuild) {
        if ($backendImage.Contains('@') -or $sutImage.Contains('@') -or $frontendImage.Contains('@')) {
            throw 'Pinned registry digests require -SkipBuild; local builds use image tags.'
        }
        & docker build -t $backendImage -t $sutImage $backendDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Backend image build failed.' }
        & docker build -t $frontendImage $frontendDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Frontend image build failed.' }
    }
    & docker compose --env-file $deploymentEnv -f $composeFile up -d --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Stack startup failed. Inspect docker compose logs.' }
    $publicOrigin = $deploymentValues['PUBLIC_ORIGIN']
    if (-not $publicOrigin) { $publicOrigin = 'http://localhost:8088' }
    $ready = Invoke-RestMethod -Uri "$publicOrigin/api/v1/ready" -TimeoutSec 15
    if ($ready.status -ne 'ready') { throw 'Evaluator API is not ready.' }
    Write-Host "Ready: $publicOrigin/architectures"
} finally {
    Pop-Location
}
