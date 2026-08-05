<#
.SYNOPSIS
  intentic recreate (Windows) - bootstrap shim. The flow itself (update/rebuild, env replay, overlay re-base,
  the run command the image emits) lives in the `ic` CLI (_sandbox/ic); this script only fetches the binary
  and forwards the parameter shapes the platform's cards hand out: -Slug alone = update, -Slug + -Hash =
  rebuild (the SHA256 is the trust anchor - only overlay content that still hashes to what the owner
  reviewed is ever built).

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123        # update
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/rebuild))) -Slug abc123 -Hash <sha256>   # rebuild
#>
param(
    [Parameter(Mandatory = $true)][string]$Slug,
    # Present => rebuild (the approved overlay, pinned to this digest); absent => update (the fresh base).
    [string]$Hash
)
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# ---- fetch the ic CLI (keep in lockstep with connect.ps1 - standalone irm|iex files) ----
# Downloaded on EVERY run, so re-running a card's command upgrades an existing install; only a failed
# download falls back to what's installed. IC_BIN overrides for local dev.
$Ic = $env:IC_BIN
if (-not $Ic) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    Write-Host 'intentic: fetching the ic CLI...'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile "$IcDest.tmp"
        Move-Item -Force "$IcDest.tmp" $IcDest
        $Ic = $IcDest
    } catch {
        Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
        if (Test-Path $IcDest) {
            Write-Host "note: could not download the latest ic CLI - continuing with the installed $IcDest."
            $Ic = $IcDest
        } else {
            $installed = Get-Command ic -ErrorAction SilentlyContinue
            if ($installed) {
                Write-Host "note: could not download the latest ic CLI - continuing with the installed $($installed.Source)."
                $Ic = $installed.Source
            } else {
                Write-Error 'could not download the ic CLI and none is installed - check your network and re-run.'
                exit 1
            }
        }
    }
}

if ($Hash) {
    & $Ic sandbox rebuild $Slug $Hash
} else {
    & $Ic sandbox update $Slug
}
exit $LASTEXITCODE
