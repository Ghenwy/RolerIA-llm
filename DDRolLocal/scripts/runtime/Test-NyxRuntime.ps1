param(
    [ValidateSet("64k", "96k", "112k")]
    [string]$Profile,

    [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,

    [string]$ConfigPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path "config\runtime-profiles.json"),

    [switch]$Json,
    [switch]$RequireReady
)

$ErrorActionPreference = "Stop"
$Checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $Checks.Add([pscustomobject]@{ name = $Name; status = $(if ($Passed) { "PASS" } else { "FAIL" }); detail = $Detail })
}

$ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
$ResolvedConfig = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ResolvedConfig -PathType Leaf)) {
    Add-Check "config_exists" $false $ResolvedConfig
    $Report = [pscustomobject]@{ schema = "nyx.runtime.preflight.v1"; status = "NOT_READY"; profile = $Profile; root = $ResolvedRoot; checks = $Checks }
    $Report | ConvertTo-Json -Depth 8 -Compress
    if ($RequireReady) { exit 1 }
    return
}

$Config = Get-Content -LiteralPath $ResolvedConfig -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Profile)) { $Profile = [string]$Config.production_profile }
$Selected = @($Config.profiles | Where-Object { $_.profile -eq $Profile })
Add-Check "profile_unique" ($Selected.Count -eq 1) "profile=$Profile matches=$($Selected.Count)"
if ($Selected.Count -ne 1) {
    $Report = [pscustomobject]@{ schema = "nyx.runtime.preflight.v1"; status = "NOT_READY"; profile = $Profile; root = $ResolvedRoot; checks = $Checks }
    $Report | ConvertTo-Json -Depth 8 -Compress
    if ($RequireReady) { exit 1 }
    return
}
$RuntimeProfile = $Selected[0]
$SchemaName = if ($RuntimeProfile.schema_version -eq '1.1') { 'runtime-profile-v1.1.schema.json' } else { 'runtime-profile.schema.json' }
$SchemaFile = Join-Path $PSScriptRoot "..\..\packages\contracts\schemas\design\$SchemaName"
$SchemaValid = Test-Json -Json ($RuntimeProfile | ConvertTo-Json -Depth 20 -Compress) -SchemaFile $SchemaFile -ErrorAction SilentlyContinue
Add-Check "runtime_profile_schema" $SchemaValid "schema=$SchemaName"
$ConfiguredModelHash = ([string]$Config.model.sha256).Trim().ToLowerInvariant()
Add-Check "gguf_hash_configured" ($ConfiguredModelHash -match "^[a-f0-9]{64}$") "configured=$ConfiguredModelHash"
Add-Check "loopback_only" ($RuntimeProfile.host -eq "127.0.0.1") "host=$($RuntimeProfile.host)"
Add-Check "parallel_three" ($RuntimeProfile.parallel -eq 3) "parallel=$($RuntimeProfile.parallel)"
Add-Check "kv_q5_1" (($RuntimeProfile.cache_type_k -eq "Q5_1") -and ($RuntimeProfile.cache_type_v -eq "Q5_1")) "K=$($RuntimeProfile.cache_type_k) V=$($RuntimeProfile.cache_type_v)"

$ServerCandidates = @(
    (Join-Path $ResolvedRoot "runtime\llama.cpp\llama-server.exe"),
    (Join-Path $ResolvedRoot "runtime\llama.cpp\build\bin\Release\llama-server.exe"),
    (Join-Path $ResolvedRoot "runtime\llama.cpp\build\bin\llama-server.exe")
)
$RuntimeTrusted = $true
$PinnedRuntime = $RuntimeProfile.PSObject.Properties.Name -contains 'runtime'
if ($PinnedRuntime -or $Profile -eq '64k') {
    $RuntimeTrusted = $false
    $ServerCandidates = @()
    $Pin = $RuntimeProfile.runtime
    $SafeRuntimePath = $SchemaValid -and ([string]$Pin.executable -cmatch '^runtime/(?:[A-Za-z0-9_-]+/)+llama-server\.exe$')
    Add-Check "runtime_path_safe" $SafeRuntimePath "Configured runtime path must remain inside runtime/."
    if ($SafeRuntimePath) {
        $PinnedServer = [System.IO.Path]::GetFullPath((Join-Path $ResolvedRoot $Pin.executable))
        $ReparseFree = $true
        $CurrentPath = $ResolvedRoot
        foreach ($Segment in ([string]$Pin.executable).Split('/')) {
            $CurrentPath = Join-Path $CurrentPath $Segment
            if ((Test-Path -LiteralPath $CurrentPath) -and ((Get-Item -LiteralPath $CurrentPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $ReparseFree = $false }
        }
        Add-Check "runtime_no_reparse_points" $ReparseFree "Pinned executable and parents cannot redirect outside the product."
        if ($ReparseFree) { $ServerCandidates = @($PinnedServer) }
    }
}
$Server = $ServerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
Add-Check "llama_server_exists" ($null -ne $Server) $(if ($null -eq $Server) { $ServerCandidates -join ";" } else { $Server })
if ($PinnedRuntime -and $null -ne $Server) {
    $ExeHash = (Get-FileHash -LiteralPath $Server -Algorithm SHA256).Hash.ToLowerInvariant()
    $RuntimeTrusted = $ExeHash -ceq [string]$Pin.sha256
    Add-Check "runtime_executable_hash" $RuntimeTrusted "actual=$ExeHash configured=$($Pin.sha256)"
    $RuntimeDirectory = Split-Path -Parent $Server
    $ExpectedDlls = @($Pin.artifacts.PSObject.Properties.Name | Sort-Object)
    $ActualDlls = @(Get-ChildItem -LiteralPath $RuntimeDirectory -Filter '*.dll' -File | Select-Object -ExpandProperty Name | Sort-Object)
    $DllSetMatches = ($ExpectedDlls -join '|') -ceq ($ActualDlls -join '|')
    Add-Check "runtime_dll_inventory" $DllSetMatches "expected=$($ExpectedDlls.Count) actual=$($ActualDlls.Count)"
    $RuntimeTrusted = $RuntimeTrusted -and $DllSetMatches
    foreach ($Dll in $ExpectedDlls) {
        $DllPath = Join-Path $RuntimeDirectory $Dll
        $DllHash = if ((Test-Path -LiteralPath $DllPath -PathType Leaf) -and -not ((Get-Item -LiteralPath $DllPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            (Get-FileHash -LiteralPath $DllPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } else { '' }
        $Matches = $DllHash -ceq [string]$Pin.artifacts.$Dll
        Add-Check "runtime_dll_$Dll" $Matches "actual=$DllHash configured=$($Pin.artifacts.$Dll)"
        $RuntimeTrusted = $RuntimeTrusted -and $Matches
    }
}

$ModelDirectory = if ($Config.model.PSObject.Properties.Name -contains 'directory') { [string]$Config.model.directory } else { 'nyx-rp-9b' }
$ModelFile = [string]$Config.model.file
$SafeModelPath = ($ModelDirectory -cmatch '^[a-zA-Z0-9_-]+$') -and ($ModelFile -cmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.gguf$')
Add-Check "gguf_path_safe" $SafeModelPath "directory=$ModelDirectory file=$ModelFile"
if (-not $SafeModelPath) {
    $Report = [pscustomobject]@{ schema = "nyx.runtime.preflight.v1"; status = "NOT_READY"; profile = $Profile; root = $ResolvedRoot; checks = $Checks }
    $Report | ConvertTo-Json -Depth 8 -Compress
    if ($RequireReady) { exit 1 }
    return
}
$Model = Join-Path (Join-Path (Join-Path $ResolvedRoot 'models') $ModelDirectory) $ModelFile
$HashFile = Join-Path (Split-Path -Parent $Model) "SHA256-local.txt"
$ModelExists = Test-Path -LiteralPath $Model -PathType Leaf
Add-Check "gguf_exists" $ModelExists $Model
$ModelHash = $null
if ($ModelExists) {
    $ModelHash = (Get-FileHash -LiteralPath $Model -Algorithm SHA256).Hash.ToLowerInvariant()
    $RecordedHash = if (Test-Path -LiteralPath $HashFile -PathType Leaf) { (Get-Content -LiteralPath $HashFile -Raw).Trim().ToLowerInvariant() } else { "" }
    Add-Check "gguf_hash_recorded" ($RecordedHash -match "^[a-f0-9]{64}$") $HashFile
    Add-Check "gguf_hash_sidecar_matches_config" ($RecordedHash -eq $ConfiguredModelHash) "sidecar=$RecordedHash configured=$ConfiguredModelHash"
    Add-Check "gguf_hash_matches" ($ConfiguredModelHash -eq $ModelHash) "actual=$ModelHash configured=$ConfiguredModelHash"
}

$Nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
Add-Check "nvidia_smi_available" ($null -ne $Nvidia) $(if ($null -eq $Nvidia) { "nvidia-smi no disponible" } else { $Nvidia.Source })
if ($null -ne $Nvidia) {
    $Gpu = (& $Nvidia.Source --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    Add-Check "gpu_query" (-not [string]::IsNullOrWhiteSpace($Gpu)) ([string]$Gpu)
}

if ($null -ne $Server -and $RuntimeTrusted -and $SchemaValid) {
    $Help = (& $Server --help 2>&1 | Out-String)
    Add-Check "runtime_help_exit" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
    $RequiredFlags = @(
        "--parallel", "--cont-batching", "--kv-unified", "--kv-unified-per-slot",
        "--cache-type-k", "--cache-type-v", "--flash-attn", "--fit", "--fit-target",
        "--load-mode", "--jinja", "--host", "--port",
        "--cors-origins", "--no-webui", "--log-file"
    )
    foreach ($Flag in $RequiredFlags) {
        Add-Check ("flag_" + $Flag.TrimStart("-").Replace("-", "_")) ($Help.Contains($Flag)) $Flag
    }
}

$Ready = @($Checks | Where-Object { $_.status -eq "FAIL" }).Count -eq 0
$Report = [pscustomobject]@{
    schema = "nyx.runtime.preflight.v1"
    status = $(if ($Ready) { "READY" } else { "NOT_READY" })
    profile = $Profile
    root = $ResolvedRoot
    server = $Server
    model = $Model
    model_sha256 = $ModelHash
    api = "http://127.0.0.1:$($RuntimeProfile.port)/v1"
    checks = $Checks
}

if ($Json) { $Report | ConvertTo-Json -Depth 8 -Compress } else { $Report }
if ($RequireReady -and -not $Ready) { exit 1 }
