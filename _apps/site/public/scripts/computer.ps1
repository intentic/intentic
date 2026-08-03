# intentic - connect THIS Windows computer to your sandbox, so the agent can work on it: run PowerShell, read
# and write files inside the folders you allow, and see the screen. Runs as YOU (no admin): installs into
# %USERPROFILE%\.intentic\host and registers a per-user logon entry so the computer reconnects after a reboot.
# `intentic-host uninstall` removes it. Nothing is opened on your network - the connection is outbound only.
#
# What the agent may actually do here is decided on the sandbox's capability card, not by this script, and is
# enforced by the agent installed on this machine. Revoking it there cuts this machine off immediately.
#
# Usage (the computer's capability card hands you this):
#   $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:PAIR_TOKEN='<token>'; irm https://intentic.dev/host.ps1 | iex
#
# Required env: SANDBOX_URL, PAIR_TOKEN (the one-time token from the card).
# Optional: AGENT_BIN - local dev / dogfooding an unreleased build: run this command instead of downloading a
#           release, whitespace-separated (e.g. "node C:\intentic\_apps\host\dist\cli.js").
$ErrorActionPreference = 'Stop'

$url = $env:SANDBOX_URL
$pair = $env:PAIR_TOKEN
if ([string]::IsNullOrEmpty($url) -or [string]::IsNullOrEmpty($pair)) {
    Write-Error 'SANDBOX_URL and PAIR_TOKEN are required (copy the command from the computer''s card in your sandbox).'
    exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
# AGENT_BIN (local dev) short-circuits the download; otherwise the published binary is fetched on EVERY run, so
# re-running the card's command upgrades an existing install rather than pinning the machine to the version it
# first connected with.
$bin = $env:AGENT_BIN
if (-not $bin) {
    $dest = Join-Path $HOME '.intentic\host\bin\intentic-host.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Write-Host 'Downloading the intentic-host agent...'
    try {
        # Download beside the target, then swap: the connection runs FROM $dest, and Windows refuses to overwrite
        # or delete a running executable - but it does allow RENAMING one out of the way, which leaves the live
        # process running from the renamed file while the new binary takes its place. The leftover is cleared on
        # the next run, once nothing is executing it. A half-download never becomes $dest either.
        Invoke-WebRequest -UseBasicParsing -Uri "https://gitlab.com/api/v4/projects/radarsu%2Fintentic/packages/generic/intentic-host/latest/intentic-host-windows-$arch.exe" -OutFile "$dest.tmp"
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.old"
        if (Test-Path $dest) { Move-Item -Force -Path $dest -Destination "$dest.old" }
        Move-Item -Force -Path "$dest.tmp" -Destination $dest
        $bin = $dest
    } catch {
        Remove-Item -Force -ErrorAction SilentlyContinue "$dest.tmp"
        $installed = (Get-Command intentic-host -ErrorAction SilentlyContinue).Source
        if ($installed) { Write-Warning "Could not download the latest agent - continuing with the installed $installed."; $bin = $installed }
        elseif (Get-Command npx -ErrorAction SilentlyContinue) { $bin = 'npx' }
        else { Write-Error 'Could not download the agent and no npx fallback (install Node.js, or see the docs).'; exit 1 }
    }
}

$hostArgs = @('setup', '--url', $url, '--pair', $pair)
if (-not [string]::IsNullOrEmpty($env:AGENT_BIN)) {
    # A whitespace-separated command: first token is the executable, the rest are leading args before setup.
    $parts = $env:AGENT_BIN -split '\s+'
    $lead = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
    & $parts[0] @($lead + $hostArgs)
} elseif ($bin -eq 'npx') { & npx -y '@intentic/host@latest' @hostArgs } else { & $bin @hostArgs }
