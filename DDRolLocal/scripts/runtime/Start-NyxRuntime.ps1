param(
    [ValidateSet("64k", "96k", "112k")]
    [string]$Profile,

    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,

    [switch]$Detached
)

$ErrorActionPreference = "Stop"
$ConfigPath = Join-Path $Root "config\runtime-profiles.json"
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Profile)) { $Profile = [string]$Config.production_profile }
$PreflightPath = Join-Path $PSScriptRoot "Test-NyxRuntime.ps1"
$PreflightJson = & $PreflightPath -Profile $Profile -Root $Root -ConfigPath $ConfigPath -Json
$Preflight = $PreflightJson | ConvertFrom-Json
if ($Preflight.status -ne "READY") {
    throw "Runtime NOT_READY. Ejecuta Test-NyxRuntime.ps1 para ver los checks fallidos."
}

$RuntimeProfile = @($Config.profiles | Where-Object { $_.profile -eq $Profile })[0]
$Arguments = @(
    "-m", [string]$Preflight.model,
    "--alias", [string]$Config.model.alias,
    "--parallel", [string]$RuntimeProfile.parallel,
    "--cont-batching",
    "--kv-unified",
    "--kv-unified-per-slot", [string]$RuntimeProfile.context_per_slot,
    "--cache-type-k", ([string]$RuntimeProfile.cache_type_k).ToLowerInvariant(),
    "--cache-type-v", ([string]$RuntimeProfile.cache_type_v).ToLowerInvariant(),
    "--flash-attn", "on",
    "--batch-size", [string]$RuntimeProfile.batch,
    "--ubatch-size", [string]$RuntimeProfile.ubatch,
    "--fit", "on",
    "--fit-target", [string]$RuntimeProfile.fit_target_mib,
    "--load-mode", "mmap",
    "--jinja",
    "--cors-origins", "localhost",
    "--no-webui",
    "--host", "127.0.0.1",
    "--port", [string]$RuntimeProfile.port
)

$Logs = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Log = Join-Path $Logs "nyx-rpg-$Profile-$Timestamp.log"

Write-Host "NYX RPG runtime"
Write-Host "Profile:      $Profile"
Write-Host "Slots:        $($RuntimeProfile.parallel)"
Write-Host "Context/slot: $($RuntimeProfile.context_per_slot)"
Write-Host "API:          http://127.0.0.1:$($RuntimeProfile.port)/v1"
Write-Host "Log:          $Log"

$PriorNoPinned = [Environment]::GetEnvironmentVariable('GGML_CUDA_NO_PINNED', 'Process')
try {
    # Only the versioned, preflight-validated allowlisted setting is inherited by this child.
    if ($RuntimeProfile.PSObject.Properties.Name -contains 'runtime') {
        [Environment]::SetEnvironmentVariable('GGML_CUDA_NO_PINNED', [string]$RuntimeProfile.runtime.environment.GGML_CUDA_NO_PINNED, 'Process')
    }
if ($Detached) {
    # PowerShell's redirected CreateProcess path inherits capture pipes beyond the launcher.
    # The native logger keeps diagnostics while ShellExecute returns independently of server lifetime.
    $RuntimeProcess = Start-Process `
        -FilePath $Preflight.server `
        -ArgumentList ($Arguments + @('--log-file', ('"{0}"' -f $Log))) `
        -WindowStyle Hidden `
        -PassThru
    Write-Output "NYX_RUNTIME_PID=$($RuntimeProcess.Id)"
    exit 0
}

& $Preflight.server @Arguments 2>&1 | Tee-Object -FilePath $Log
exit $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable('GGML_CUDA_NO_PINNED', $PriorNoPinned, 'Process')
}
