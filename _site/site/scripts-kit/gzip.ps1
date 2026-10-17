# The .gz copy a release publishes beside each binary, unpacked: under half the bytes cross the network (42 of the agent's
# 93 MB), and .NET's GZipStream, which Windows PowerShell 5.1 has too, is all it takes. The binary is checked against
# the release's SHA256SUMS line for the binary itself, so the copy changes how many bytes arrive and nothing about
# which bytes are trusted.
function Expand-IntenticGzip {
    param([string]$Source, [string]$Destination)
    $in = $null
    $gzip = $null
    $out = $null
    try {
        $in = [System.IO.File]::OpenRead($Source)
        $gzip = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
        $out = [System.IO.File]::Create($Destination)
        $gzip.CopyTo($out)
    } finally {
        if ($null -ne $out) { $out.Close() }
        if ($null -ne $gzip) { $gzip.Close() }
        if ($null -ne $in) { $in.Close() }
    }
}

# Whether a failed request was a 404: what a release from before the copies answers for one, and the signal to fetch
# the binary itself instead. A .NET method's failure arrives wrapped, so the WebException is looked for.
function Test-IntenticMissing($Failure) {
    while ($null -ne $Failure -and -not ($Failure -is [System.Net.WebException])) { $Failure = $Failure.InnerException }
    return ($null -ne $Failure -and $null -ne $Failure.Response -and [int]$Failure.Response.StatusCode -eq 404)
}
