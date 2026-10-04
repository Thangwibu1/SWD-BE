[CmdletBinding()]
param(
  [string]$ApiBaseUrl = 'http://localhost:4100/api/v1',
  [string[]]$Architectures = (1..12 | ForEach-Object { 'A{0:D2}' -f $_ }),
  [ValidateRange(1, 10000)]
  [int]$TargetRps = 1,
  [ValidateRange(0, 3600)]
  [int]$WarmupSeconds = 1,
  [ValidateRange(1, 86400)]
  [int]$MeasureSeconds = 10,
  [ValidateRange(0, 3600)]
  [int]$CooldownSeconds = 0,
  [ValidateRange(1, 240)]
  [int]$TimeoutMinutes = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')
$Architectures = @($Architectures | ForEach-Object { $_.ToUpperInvariant() } | Select-Object -Unique)
if ($Architectures.Count -eq 0 -or @($Architectures | Where-Object { $_ -notmatch '^A(?:0[1-9]|1[0-2])$' }).Count -gt 0) {
  throw 'Architectures must contain one or more IDs from A01 through A12.'
}

Write-Host "Checking evaluator API at $ApiBaseUrl ..."
$ready = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/ready"
if ($ready.status -ne 'ready') {
  throw "Evaluator API is not ready: $($ready | ConvertTo-Json -Depth 8 -Compress)"
}

$runToken = "all-architectures-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$jobs = @()

foreach ($architectureId in $Architectures) {
  $body = @{
    name = "Backend smoke $architectureId"
    workloadProfile = 'MIXED_V1'
    loadLevelsRps = @($TargetRps)
    warmupSeconds = $WarmupSeconds
    measureSeconds = $MeasureSeconds
    cooldownSeconds = $CooldownSeconds
    repetitions = 1
    invalidRetryLimit = 0
    datasetProfile = 'pilot'
    costCatalogVersion = 'research-v1'
    scoreBoundsVersion = 'development-v1'
    slo = @{
      p99Ms = 100
      errorRateMax = 0.01
      consistencyViolationsMax = 0
    }
  } | ConvertTo-Json -Depth 6 -Compress

  $headers = @{ 'Idempotency-Key' = "$runToken-$architectureId" }
  $response = Invoke-RestMethod -Method Post `
    -Uri "$ApiBaseUrl/architectures/$architectureId/experiments" `
    -Headers $headers `
    -ContentType 'application/json' `
    -Body $body

  $jobs += [PSCustomObject]@{
    Architecture = $architectureId
    ExperimentId = $response.experimentId
    Status = $response.status
  }
  Write-Host "Queued $architectureId -> $($response.experimentId)"
}

$terminalStatuses = @('COMPLETED', 'FAILED', 'CLEANUP_FAILED', 'CANCEL_REQUESTED')
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
Write-Host "Waiting for the single worker to execute $($Architectures.Count) experiment(s) ..."

while ($true) {
  $remaining = 0
  foreach ($job in $jobs) {
    if ($terminalStatuses -contains $job.Status) {
      continue
    }
    $experiment = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/experiments/$($job.ExperimentId)"
    if ($job.Status -ne $experiment.status) {
      $job.Status = $experiment.status
      Write-Host "$($job.Architecture): $($job.Status)"
    }
    if ($terminalStatuses -notcontains $job.Status) {
      $remaining += 1
    }
  }

  if ($remaining -eq 0) {
    break
  }
  if ((Get-Date) -ge $deadline) {
    $jobs | Format-Table -AutoSize
    throw "Timed out after $TimeoutMinutes minutes with $remaining experiment(s) unfinished."
  }
  Start-Sleep -Seconds 3
}

$jobs | Sort-Object Architecture | Format-Table -AutoSize
$failures = @($jobs | Where-Object { $_.Status -ne 'COMPLETED' })
if ($failures.Count -gt 0) {
  throw "$($failures.Count) of $($Architectures.Count) architecture smoke tests did not complete successfully."
}

Write-Host "All $($Architectures.Count) architecture smoke tests completed successfully."
