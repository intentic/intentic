# intentic desktop sync (Windows) — install the sync agent on THIS machine and two-way sync a local folder with
# your sandbox's /work (block-delta, near-real-time, powered by Mutagen). Runs as YOU (no admin): installs into
# %USERPROFILE%\.intentic\sync and registers a per-user logon task.
#
# Usage (the platform's Desktop sync card hands you this):
#   $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:PAIR_TOKEN='<token>'; $env:SYNC_DIR="$HOME\intentic\<name>"; irm https://intentic.dev/sync.ps1 | iex
#
# Required env: SANDBOX_URL, PAIR_TOKEN (the one-time token from the card).
# Optional: SYNC_DIR (default: ~\intentic\<host>); TAKEOVER (any non-empty value takes over sync from another machine).
$ErrorActionPreference = 'Stop'

$url = $env:SANDBOX_URL
$pair = $env:PAIR_TOKEN
$dir = $env:SYNC_DIR
if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
    Write-Error 'SANDBOX_URL and PAIR_TOKEN are required (copy the command from the Desktop sync card).'
    exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$bin = (Get-Command intentic-sync -ErrorAction SilentlyContinue).Source
if (-not $bin) {
    $dest = Join-Path $HOME '.intentic\sync\bin\intentic-sync.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Write-Host 'Downloading the intentic-sync agent…'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads/bin/intentic-sync-windows-$arch.exe" -OutFile $dest
        $bin = $dest
    } catch {
        if (Get-Command npx -ErrorAction SilentlyContinue) { $bin = 'npx' } else { Write-Error 'Could not download the agent and no npx fallback (install Node.js, or see the docs).'; exit 1 }
    }
}

$syncArgs = @('setup', '--url', $url, '--pair', $pair)
if (-not [string]::IsNullOrEmpty($dir)) { $syncArgs += @('--dir', $dir) }
if (-not [string]::IsNullOrEmpty($env:TAKEOVER)) { $syncArgs += @('--takeover') }
if ($bin -eq 'npx') { & npx -y '@intentic/sync@latest' @syncArgs } else { & $bin @syncArgs }
