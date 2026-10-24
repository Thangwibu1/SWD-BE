[CmdletBinding()]
param(
  [string]$ApiBaseUrl = 'http://localhost:4100/api/v1',
  [string[]]$Architectures = @(),
  [ValidateSet('BROWSING_V1', 'MIXED_V1', 'CHECKOUT_V1', 'FLASH_SALE_V1')]
  [string]$WorkloadProfile = 'MIXED_V1',
  [ValidateRange(1, 10000)]
  [int]$TargetRps = 1,
  [ValidateRange(0, 3600)]
  [int]$WarmupSeconds = 10,
  [ValidateRange(1, 86400)]
  [int]$MeasureSeconds = 120,
  [ValidateRange(0, 3600)]
  [int]$CooldownSeconds = 0,
  [ValidateRange(1, 240)]
  [int]$TimeoutMinutes = 240,
  [string]$EvidenceDirectory = '',
  [switch]$CollectOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ApiBaseUrl = $ApiBaseUrl.TrimEnd('/')
$supportedIds = @((Invoke-RestMethod -Uri "$ApiBaseUrl/architectures").architectures.id)
if ($Architectures.Count -eq 0) { $Architectures = $supportedIds }
$Architectures = @($Architectures | ForEach-Object { $_.ToUpperInvariant() } | Select-Object -Unique)
if ($Architectures.Count -eq 0 -or @($Architectures | Where-Object { $_ -notin $supportedIds }).Count -gt 0) {
  throw "Architectures must be registered: $($supportedIds -join ', ')."
}

Write-Host "Checking evaluator API at $ApiBaseUrl ..."
$ready = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/ready"
if ($ready.status -ne 'ready') {
  throw "Evaluator API is not ready: $($ready | ConvertTo-Json -Depth 8 -Compress)"
}

$runToken = "all-architectures-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path 'results' $runToken }
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$jobs = @()

if ($CollectOnly) {
  $campaignPath = Join-Path $EvidenceDirectory 'campaign.json'
  if (-not (Test-Path -LiteralPath $campaignPath)) { throw 'CollectOnly requires an existing EvidenceDirectory/campaign.json.' }
  $jobs = @(Get-Content -LiteralPath $campaignPath -Raw | ConvertFrom-Json)
  foreach ($job in $jobs) { $job.Status = 'PENDING' }
  $Architectures = @($jobs.Architecture)
} else {
foreach ($architectureId in $Architectures) {
  $body = @{
    name = "Backend smoke $architectureId"
    workloadProfile = $WorkloadProfile
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
$jobs | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory 'campaign.json')
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
$jobs | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory 'campaign.json')
$failures = @($jobs | Where-Object { $_.Status -ne 'COMPLETED' })
if ($failures.Count -eq 0) {
  Write-Host "All $($Architectures.Count) architecture smoke tests completed successfully."
} else {
  Write-Host "Collecting evidence before reporting $($failures.Count) unsuccessful experiment(s)."
}
$summary = @()
foreach ($job in $jobs) {
  $result = Invoke-RestMethod "$ApiBaseUrl/experiments/$($job.ExperimentId)/results"
  $result | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory "$($job.Architecture)-results.json")
  $artifacts = Invoke-RestMethod "$ApiBaseUrl/experiments/$($job.ExperimentId)/artifacts"
  $oracleArtifact = @($artifacts.artifacts | Where-Object { $_.relativePath -eq 'raw/invariant-output.json' })
  if ($oracleArtifact.Count -ne 1) { throw "Expected one invariant artifact for $($job.Architecture)" }
  $oraclePath = Join-Path $EvidenceDirectory "$($job.Architecture)-invariants.json"
  Invoke-WebRequest "$ApiBaseUrl/experiments/$($job.ExperimentId)/artifacts/$($oracleArtifact[0].id)/download" -OutFile $oraclePath | Out-Null
  if ((Get-FileHash -LiteralPath $oraclePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oracleArtifact[0].sha256) {
    throw "Invariant artifact checksum mismatch for $($job.Architecture)"
  }
  $oracle = Get-Content -LiteralPath $oraclePath -Raw | ConvertFrom-Json
  $resultRuns = @($result.results)
  if ($resultRuns.Count -eq 0) {
    # Official results exclude infrastructure-invalid runs. Preserve their raw
    # measurements with the FAILED status rather than silently omitting the ID.
    $fullExperiment = Invoke-RestMethod "$ApiBaseUrl/experiments/$($job.ExperimentId)"
    $fullExperiment | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory "$($job.Architecture)-experiment.json")
    $resultRuns = @(foreach ($rawRun in $fullExperiment.runs) {
      if ($rawRun.metrics_json -and $rawRun.gates_json) {
        [PSCustomObject]@{ metrics = $rawRun.metrics_json; gates = $rawRun.gates_json }
      }
    })
  }
  foreach ($run in $resultRuns) {
    $summary += [PSCustomObject]@{
      Architecture = $job.Architecture
      ExperimentStatus = $job.Status
      P99Ms = $run.metrics.p99Ms
      ErrorRate = $run.metrics.errorRate
      Invariants = $oracle.passed -and $oracle.violations.Count -eq 7 -and @($oracle.violations | Where-Object { -not $_.passed }).Count -eq 0
      Correctness = @($run.gates.gates | Where-Object { $_.code -eq 'GATE_CORRECTNESS' })[0].passed
      Stability = @($run.gates.gates | Where-Object { $_.code -eq 'GATE_STABILITY' })[0].passed
      FailedGates = (@($run.gates.gates | Where-Object { -not $_.passed } | ForEach-Object { $_.code }) -join ', ')
    }
  }
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceDirectory 'summary.json')
$summary | Format-Table -AutoSize
if ($failures.Count -gt 0) {
  throw "$($failures.Count) of $($Architectures.Count) architecture smoke tests did not complete successfully. Evidence: $EvidenceDirectory"
}
if (@($summary | Where-Object { -not $_.Invariants -or -not $_.Correctness -or -not $_.Stability }).Count -gt 0) {
  throw "An architecture failed correctness or stability. Evidence: $EvidenceDirectory"
}
Write-Host "Evidence: $EvidenceDirectory. Completion does not imply passing the performance SLO."
