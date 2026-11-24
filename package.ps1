param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd([char[]]@('\','/'))
$packagePath = [IO.Path]::GetFullPath($Output)
$temporaryPath = "$packagePath.tmp"
try {
    [IO.File]::Delete($temporaryPath)
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew)
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $sourcePath -File -Recurse) {
                $name = $file.FullName.Substring($sourcePath.Length + 1).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
    Move-Item -LiteralPath $temporaryPath -Destination $packagePath -Force
} finally {
    [IO.File]::Delete($temporaryPath)
}
Write-Output $packagePath
