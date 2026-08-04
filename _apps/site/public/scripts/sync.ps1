# intentic desktop sync (Windows) - install the sync agent on THIS machine, two-way sync a local folder with
# your sandbox's /work (block-delta, near-real-time), and mirror the sandbox's dev-server ports onto this
# machine's localhost (both powered by Mutagen). Runs as YOU (no admin): installs into %USERPROFILE%\.intentic\sync
# and registers per-user logon tasks (the Mutagen daemon + the port-mirror watcher) so both resume after a
# reboot. `intentic-sync uninstall` removes everything.
#
# Usage (the platform's Desktop sync card hands you this):
#   $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:PAIR_TOKEN='<token>'; $env:SYNC_DIR="$HOME\intentic\<name>-<id>"; irm https://intentic.dev/sync.ps1 | iex
#
# Required env: SANDBOX_URL, PAIR_TOKEN (the one-time token from the card).
# Optional: SYNC_DIR (default: ~\intentic\<id>, the same id the sandbox's own URL carries); TAKEOVER (any non-empty value takes over sync from another machine).
#   AGENT_BIN  local dev / dogfooding an unreleased build: run this command instead of downloading a release,
#              whitespace-separated (e.g. "node C:\intentic\_apps\sync\dist\cli.js"; a path with spaces needs a wrapper .cmd).
$ErrorActionPreference = 'Stop'

$url = $env:SANDBOX_URL
$pair = $env:PAIR_TOKEN
$dir = $env:SYNC_DIR
if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
    Write-Error 'SANDBOX_URL and PAIR_TOKEN are required (copy the command from the Desktop sync card).'
    exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
# AGENT_BIN (local dev) short-circuits the download; otherwise the published binary is fetched on EVERY run, so
# re-running the card's command upgrades an existing install. Resolving an already-installed agent first pinned a
# machine to the version it first paired with, and agent fixes could never reach anyone already syncing (the
# ignore rules that decide whether a project's .git travels to the sandbox among them).
$bin = $env:AGENT_BIN
if (-not $bin) {
    $dest = Join-Path $HOME '.intentic\sync\bin\intentic-sync.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Write-Host 'Downloading the intentic-sync agent...'
    try {
        # Download beside the target, then swap: the mirror watcher runs FROM $dest, and Windows refuses to
        # overwrite or delete a running executable - but it does allow RENAMING one out of the way, which leaves
        # the live watcher running from the renamed file while the new binary takes its place. The leftover is
        # cleared on the next run, once nothing is executing it. A half-download never becomes $dest either.
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/intentic/intentic/releases/latest/download/intentic-sync-windows-$arch.exe" -OutFile "$dest.tmp"
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.old"
        if (Test-Path $dest) { Move-Item -Force -Path $dest -Destination "$dest.old" }
        Move-Item -Force -Path "$dest.tmp" -Destination $dest
        $bin = $dest
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.tmp"
        $installed = (Get-Command intentic-sync -ErrorAction SilentlyContinue).Source
        if ($installed) { Write-Warning "Could not download the latest agent - continuing with the installed $installed."; $bin = $installed }
        elseif (Get-Command npx -ErrorAction SilentlyContinue) { $bin = 'npx' }
        else { Write-Error 'Could not download the agent and no npx fallback (install Node.js, or see the docs).'; exit 1 }
    }
}

$syncArgs = @('setup', '--url', $url, '--pair', $pair)
if (-not [string]::IsNullOrEmpty($dir)) { $syncArgs += @('--dir', $dir) }
if (-not [string]::IsNullOrEmpty($env:TAKEOVER)) { $syncArgs += @('--takeover') }
if (-not [string]::IsNullOrEmpty($env:AGENT_BIN)) {
    # A whitespace-separated command: first token is the executable, the rest are leading args before setup.
    $parts = $env:AGENT_BIN -split '\s+'
    $lead = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
    # Named, then splatted: `@(...)` is the array subexpression operator and would pass the whole argument
    # list as one space-joined string (connect.ps1 has the long version). Only `@name` splats.
    $agentArgs = $lead + $syncArgs
    & $parts[0] @agentArgs
} elseif ($bin -eq 'npx') { & npx -y '@intentic/sync@latest' @syncArgs } else { & $bin @syncArgs }
