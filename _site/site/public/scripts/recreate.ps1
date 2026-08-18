<#
.SYNOPSIS
  intentic recreate (Windows) - bootstrap shim. The flow itself (update/rebuild/rollback, env replay, overlay
  re-base, the run command the image emits) lives in the `ic` CLI (_sandbox/ic); this script only fetches the
  binary and forwards the parameter shapes the platform's cards hand out: -Slug alone = update, -Slug + -Hash =
  rebuild (the SHA256 is the trust anchor - only overlay content that still hashes to what the owner
  reviewed is ever built), -Slug + -Rollback = back to the image it ran before its last update, and
  -Slug + -Prepare = download and build the next update without applying it.

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123        # update
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/rebuild))) -Slug abc123 -Hash <sha256>   # rebuild
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -Rollback   # roll back
.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug abc123 -Prepare    # download it now
#>
param(
    [Parameter(Mandatory = $true)][string]$Slug,
    # Present => rebuild (the approved overlay, pinned to this digest); absent => update (the fresh base).
    [string]$Hash,
    # The third way through the same shim, matching recreate.sh's --rollback: the image before the last update.
    # A switch rather than a value, so it can never be confused with the digest above.
    [switch]$Rollback,
    # The fourth, matching recreate.sh's --prepare: download and build the next update and stop there. The
    # container is never touched, so this is safe to run while the sandbox is being used.
    [switch]$Prepare
)
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# ---- fetch the ic CLI (the same block connect.ps1 and connect-host.ps1 carry, apart from its one narration
#      line - these are standalone irm|iex files and cannot share code, so a test holds them to it instead) ----
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

if ($Rollback) {
    & $Ic sandbox rollback $Slug
} elseif ($Prepare) {
    & $Ic sandbox prepare $Slug
} elseif ($Hash) {
    & $Ic sandbox rebuild $Slug $Hash
} else {
    & $Ic sandbox update $Slug
}
exit $LASTEXITCODE
