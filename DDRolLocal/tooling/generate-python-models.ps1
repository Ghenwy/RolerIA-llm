param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ToolingDir = Split-Path -Parent $PSCommandPath
$ProductDir = Split-Path -Parent $ToolingDir
$ProjectDir = Join-Path $ProductDir 'fallback\python'
$SchemaRoot = Join-Path $ProductDir 'packages\contracts\schemas'
$CommittedOutput = Join-Path $ProjectDir 'src\nyx_fallback\generated'
$ManifestPath = Join-Path $ProductDir 'packages\contracts\manifests\generated-python.json'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$TempRoot = $null

function Convert-ToLf([string]$Value) {
    return (($Value -replace "`r`n", "`n") -replace "`r", "`n").TrimEnd() + "`n"
}

function Get-RelativeSchema([string]$FullName) {
    return [System.IO.Path]::GetRelativePath($SchemaRoot, $FullName).Replace('\', '/')
}

try {
    $OutputRoot = $CommittedOutput
    if ($Check) {
        $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nyx-codegen-" + [guid]::NewGuid().ToString('N'))
        $ResolvedTempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $ResolvedTemp = [System.IO.Path]::GetFullPath($TempRoot)
        if (-not $ResolvedTemp.StartsWith($ResolvedTempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe temporary path: $ResolvedTemp"
        }
        New-Item -ItemType Directory -Force -Path $ResolvedTemp | Out-Null
        $OutputRoot = $ResolvedTemp
    }

    New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
    $Records = @()
    $ExpectedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $Schemas = Get-ChildItem -LiteralPath $SchemaRoot -Recurse -File -Filter '*.schema.json' | Sort-Object FullName
    foreach ($Schema in $Schemas) {
        $Relative = Get-RelativeSchema $Schema.FullName
        $Stem = ($Relative -replace '/', '__' -replace '\.schema\.json$', '' -replace '[-.]', '_')
        $OutputFile = Join-Path $OutputRoot ($Stem + '.py')
        $SchemaHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Schema.FullName).Hash.ToLowerInvariant()
        $Header = "# GENERATED FILE - DO NOT EDIT. source=$Relative schema_sha256=$SchemaHash"
        $Arguments = @(
            'run', '--project', $ProjectDir, '--python', '3.12',
            'datamodel-codegen',
            '--input', $Schema.FullName,
            '--input-file-type', 'jsonschema',
            '--output', $OutputFile,
            '--output-model-type', 'pydantic_v2.BaseModel',
            '--target-python-version', '3.10',
            '--use-standard-collections',
            '--use-union-operator',
            '--disable-timestamp',
            '--formatters', 'black', 'isort',
            '--custom-file-header', $Header
        )
        & uv @Arguments
        if ($LASTEXITCODE -ne 0) { throw "datamodel-codegen failed for $Relative" }
        $Normalized = Convert-ToLf ([System.IO.File]::ReadAllText($OutputFile))
        [System.IO.File]::WriteAllText($OutputFile, $Normalized, $Utf8NoBom)
        [void]$ExpectedFiles.Add([System.IO.Path]::GetFullPath((Join-Path $CommittedOutput ($Stem + '.py'))))
        $Records += [ordered]@{
            schema_file = $Relative
            schema_sha256 = $SchemaHash
            python_file = "fallback/python/src/nyx_fallback/generated/$Stem.py"
            python_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputFile).Hash.ToLowerInvariant()
        }
    }

    $InitContent = "# GENERATED PACKAGE INDEX - models are imported explicitly by module.`n"
    $InitPath = Join-Path $OutputRoot '__init__.py'
    [System.IO.File]::WriteAllText($InitPath, $InitContent, $Utf8NoBom)
    [void]$ExpectedFiles.Add([System.IO.Path]::GetFullPath((Join-Path $CommittedOutput '__init__.py')))

    $Manifest = [ordered]@{
        schema = 'nyx.generated_python_manifest.v1'
        generator = 'datamodel-code-generator'
        python = '3.12'
        records = $Records
    }
    $ManifestContent = Convert-ToLf ($Manifest | ConvertTo-Json -Depth 10)

    if ($Check) {
        foreach ($GeneratedFile in Get-ChildItem -LiteralPath $OutputRoot -File -Filter '*.py') {
            $CommittedFile = Join-Path $CommittedOutput $GeneratedFile.Name
            if (-not (Test-Path -LiteralPath $CommittedFile)) { throw "Missing committed Python model: $($GeneratedFile.Name)" }
            if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($GeneratedFile.FullName), [byte[]][System.IO.File]::ReadAllBytes($CommittedFile))) {
                throw "Generated Python differs: $($GeneratedFile.Name)"
            }
        }
        if (-not (Test-Path -LiteralPath $ManifestPath) -or (Convert-ToLf ([System.IO.File]::ReadAllText($ManifestPath))) -ne $ManifestContent) {
            throw 'Generated Python manifest differs'
        }
        foreach ($CommittedFile in Get-ChildItem -LiteralPath $CommittedOutput -File -Filter '*.py') {
            if (-not $ExpectedFiles.Contains([System.IO.Path]::GetFullPath($CommittedFile.FullName))) { throw "Unexpected generated Python file: $($CommittedFile.Name)" }
        }
    }
    else {
        New-Item -ItemType Directory -Force -Path $CommittedOutput | Out-Null
        foreach ($GeneratedFile in Get-ChildItem -LiteralPath $OutputRoot -File -Filter '*.py') {
            if ($GeneratedFile.DirectoryName -ne $CommittedOutput) {
                Copy-Item -LiteralPath $GeneratedFile.FullName -Destination (Join-Path $CommittedOutput $GeneratedFile.Name) -Force
            }
        }
        foreach ($CommittedFile in Get-ChildItem -LiteralPath $CommittedOutput -File -Filter '*.py') {
            if ($CommittedFile.Name -ne '__init__.py' -and -not $ExpectedFiles.Contains([System.IO.Path]::GetFullPath($CommittedFile.FullName))) {
                Remove-Item -LiteralPath $CommittedFile.FullName -Force
            }
        }
        [System.IO.File]::WriteAllText($ManifestPath, $ManifestContent, $Utf8NoBom)
    }

    Write-Host "PYTHON_CODEGEN_$($Check ? 'CHECK' : 'WRITE')_OK schemas=$($Schemas.Count)"
}
finally {
    if ($TempRoot) {
        $ResolvedTempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $ResolvedTemp = [System.IO.Path]::GetFullPath($TempRoot)
        if ($ResolvedTemp.StartsWith($ResolvedTempParent, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $ResolvedTemp)) {
            Remove-Item -LiteralPath $ResolvedTemp -Recurse -Force
        }
    }
}
