$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "This gate must run on Windows."
}

$root = Split-Path -Parent $PSScriptRoot
$installer = Get-ChildItem -Path (Join-Path $root "dist") -Filter "Lynn-*-Windows-Setup.exe" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "Windows installer not found under dist/."
}

$installDir = Join-Path $env:RUNNER_TEMP "Lynn-llamacpp-installed-gate"
if (Test-Path $installDir) {
  Remove-Item -Recurse -Force $installDir
}

Write-Host "[llama.cpp] installing $($installer.Name) into $installDir"
$process = Start-Process -FilePath $installer.FullName -ArgumentList @(
  "/S",
  "/D=$installDir"
) -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($process.ExitCode)."
}

$binary = Join-Path $installDir "resources\llamacpp\bin\llama-server.exe"
if (-not (Test-Path $binary)) {
  throw "Installed llama-server.exe not found at $binary"
}

Write-Host "[llama.cpp] executing installed runtime"
& $binary --version
if ($LASTEXITCODE -ne 0) {
  throw "Installed llama-server.exe --version exited with code $LASTEXITCODE."
}

$manifest = Join-Path $installDir "resources\llamacpp\bin\runtime-manifest.json"
if (-not (Test-Path $manifest)) {
  throw "Installed runtime manifest not found at $manifest"
}
$runtime = Get-Content $manifest -Raw | ConvertFrom-Json
if ($runtime.sourceTag -ne "b10153" -or $runtime.files.PSObject.Properties.Count -ne 23) {
  throw "Installed runtime manifest does not match the pinned b10153 package."
}

$modelUrl = "https://huggingface.co/ggml-org/models/resolve/499bc8821c6b12b4e53c5bffcb21ec206f212d81/tinyllamas/stories260K.gguf?download=true"
$modelSize = 1185376
$modelSha256 = "270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d"
$model = Join-Path $env:RUNNER_TEMP "stories260K.gguf"
Write-Host "[llama.cpp] downloading pinned llama.cpp CI inference model"
Invoke-WebRequest -Uri $modelUrl -OutFile $model
if ((Get-Item $model).Length -ne $modelSize) {
  throw "GGUF smoke model size mismatch."
}
$actualModelSha = (Get-FileHash -Algorithm SHA256 $model).Hash.ToLowerInvariant()
if ($actualModelSha -ne $modelSha256) {
  throw "GGUF smoke model SHA-256 mismatch: $actualModelSha"
}

$port = 18099
$stdout = Join-Path $env:RUNNER_TEMP "llama-server.stdout.log"
$stderr = Join-Path $env:RUNNER_TEMP "llama-server.stderr.log"
$server = $null
try {
  Write-Host "[llama.cpp] starting installed runtime with a real GGUF"
  $server = Start-Process -FilePath $binary -ArgumentList @(
    "-m", $model,
    "-c", "256",
    "-n", "64",
    "--threads", "2",
    "--host", "127.0.0.1",
    "--port", "$port",
    "--no-webui"
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $healthy = $false
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    if ($server.HasExited) {
      throw "llama-server exited during model load with code $($server.ExitCode)."
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      if ($health.status -eq "ok") {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $healthy) {
    throw "llama-server did not become healthy after loading the GGUF model."
  }

  $body = @{
    prompt = "Once upon a time"
    n_predict = 16
    temperature = 0
    seed = 42
  } | ConvertTo-Json
  for ($request = 1; $request -le 2; $request++) {
    $completion = Invoke-RestMethod `
      -Method Post `
      -Uri "http://127.0.0.1:$port/completion" `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 60
    if (-not ($completion.PSObject.Properties.Name -contains "content")) {
      throw "Completion request $request returned no content field."
    }
    if ($server.HasExited) {
      throw "llama-server exited after completion request $request."
    }
    Write-Host "[llama.cpp] completion $request passed ($($completion.tokens_predicted) predicted tokens)"
  }

  Start-Sleep -Seconds 3
  if ($server.HasExited) {
    throw "llama-server did not remain alive after the stability window."
  }
} catch {
  if (Test-Path $stdout) {
    Write-Host "----- llama-server stdout -----"
    Get-Content $stdout
  }
  if (Test-Path $stderr) {
    Write-Host "----- llama-server stderr -----"
    Get-Content $stderr
  }
  throw
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
    $server.WaitForExit()
  }
}

Write-Host "[llama.cpp] installed-package load/generation gate passed: $($runtime.files.PSObject.Properties.Count) verified files"
