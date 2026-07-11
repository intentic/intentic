<#
.SYNOPSIS
  intentic cleanup (Windows) — remove intentic sandboxes' Docker footprint on THIS PC, INCLUDING the named volumes.

.DESCRIPTION
  A sandbox's /work is a NAMED Docker volume (intentic-workspace-<slug>). Removing a container "with volumes" only
  prunes ANONYMOUS volumes — a named volume survives, so a stale /work persists across re-runs and the daemon's boot
  gate then skips re-scaffolding. This removes the containers (incl. the Docker-in-Docker deploy target) AND the
  named volumes AND the networks. It leaves the platform's own resources (intentic-app-*) untouched.

  A PC can host several sandboxes at once (each suffixed by its <slug>). By DEFAULT this lists them and lets you PICK
  which to remove — it never wipes everything unless you ask. Removing a sandbox DELETES its data (/work + /history),
  so every removal is confirmed unless you pass -Yes. Non-interactive runs (no console) never auto-remove.

.PARAMETER Slug
  One or more sandbox slugs to remove. Omit to pick interactively.

.PARAMETER All
  Remove EVERY sandbox on this PC.

.PARAMETER Yes
  Skip confirmation prompts (scripts/CI).

.EXAMPLE
  irm https://intentic.dev/cleanup.ps1 | iex                                   # pick which to remove (interactive)

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/cleanup.ps1))) -All -Yes  # remove every sandbox, no prompt

.EXAMPLE
  ./cleanup.ps1 -Slug abc123def456
#>
param(
    [string[]]$Slug,
    [switch]$All,
    [switch]$Yes,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if ($Help) {
    Write-Host 'intentic cleanup — remove sandbox(es) on this PC (containers + named /work volumes + networks).'
    Write-Host 'Usage: cleanup.ps1 [-Slug <slug>...] [-All] [-Yes]'
    Write-Host '  (no arg)   pick which sandbox(es) to remove (interactive); non-interactive runs list and stop'
    Write-Host '  -Slug      remove the named sandbox(es)'
    Write-Host '  -All       remove EVERY sandbox on this PC'
    Write-Host '  -Yes       skip confirmation prompts (scripts/CI)'
    exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'docker is not installed — nothing to clean up.'
    exit 1
}

# ── shared helpers (duplicated in connect.ps1 — this script runs standalone via `irm | iex`, so it can't dot-source
# a shared file; keep the two in lockstep) ──────────────────────────────────────────────────────────────────────

# True when a console is available to prompt on (false under a non-interactive host / CI).
function Test-Interactive { [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }

# Distinct sandbox slugs on this PC — the primary containers only (the -tunnel- sidecar shares the prefix).
function Get-Sandboxes {
    @(docker ps -a --filter 'name=intentic-sandbox-' --format '{{.Names}}' 2>$null) |
        Where-Object { $_ -and $_ -notlike 'intentic-sandbox-tunnel-*' } |
        ForEach-Object { $_ -replace '^intentic-sandbox-', '' }
}

# yes/no confirmation, default NO. Honors -Yes. Non-interactive => no.
function Confirm-Action($Message) {
    if ($Yes) { return $true }
    if (-not (Test-Interactive)) { return $false }
    return (Read-Host "$Message [y/N]") -match '^[yY]'
}

# Remove one sandbox by slug: its 3 containers, 3 named volumes, and network. Idempotent (missing = no-op).
function Remove-Slug($s) {
    Write-Host "intentic: removing sandbox '$s' (containers + named volumes + network)..."
    foreach ($c in @("intentic-sandbox-$s", "intentic-sandbox-tunnel-$s", "intentic-dind-host-$s")) { docker rm -f $c *> $null }
    foreach ($v in @("intentic-workspace-$s", "intentic-history-$s", "intentic-dind-docker-$s")) { docker volume rm $v *> $null }
    docker network rm "intentic-workspace-$s" *> $null
}

# Remove EVERY sandbox by name prefix (also sweeps orphaned volumes/networks a per-slug pass would miss).
function Remove-All {
    Write-Host 'intentic: removing sandbox containers...'
    foreach ($c in (@(docker ps -aq --filter 'name=intentic-sandbox-') + @(docker ps -aq --filter 'name=intentic-dind-host-'))) { if ($c) { docker rm -f $c *> $null } }
    Write-Host 'intentic: removing named volumes (the persistent /work)...'
    foreach ($v in (@(docker volume ls -q --filter 'name=intentic-workspace-') + @(docker volume ls -q --filter 'name=intentic-history-') + @(docker volume ls -q --filter 'name=intentic-dind-docker-'))) { if ($v) { docker volume rm $v *> $null } }
    Write-Host 'intentic: removing sandbox network(s)...'
    foreach ($n in @(docker network ls -q --filter 'name=intentic-workspace-')) { if ($n) { docker network rm $n *> $null } }
}

# ── resolve which slugs to remove ─────────────────────────────────────────────────────────────────────────────
if ($All) {
    $all = @(Get-Sandboxes)
    if ($all.Count -eq 0) { Write-Host 'intentic: no sandboxes found on this PC — nothing to clean up.'; exit 0 }
    Write-Host 'intentic: about to PERMANENTLY DELETE ALL sandboxes on this PC and their data (/work + /history):'
    $all | ForEach-Object { Write-Host "    $_" }
    Write-Host 'This cannot be undone.'
    if (-not (Confirm-Action 'Remove all of them?')) { Write-Host 'intentic: cancelled — nothing removed.'; exit 0 }
    Remove-All
    Write-Host 'intentic: all sandboxes removed. Re-run connect to start fresh.'
    exit 0
}

$targets = @($Slug | Where-Object { $_ })
if ($targets.Count -eq 0) {
    # No -Slug and not -All: pick interactively, or (no console) list and stop without touching anything.
    $slugs = @(Get-Sandboxes)
    if ($slugs.Count -eq 0) { Write-Host 'intentic: no sandboxes found on this PC — nothing to clean up.'; exit 0 }

    Write-Host 'intentic: sandboxes on this PC:'
    for ($i = 0; $i -lt $slugs.Count; $i++) {
        $st = (docker inspect -f '{{.State.Status}}' "intentic-sandbox-$($slugs[$i])" 2>$null)
        if (-not $st) { $st = '?' }
        Write-Host ('  {0,2}) {1,-9} {2}' -f ($i + 1), $st, $slugs[$i])
    }

    if (-not (Test-Interactive)) {
        Write-Warning 'no console for interactive selection — nothing removed.'
        Write-Host 'Re-run with -Slug <slug>, or -All to remove every sandbox (add -Yes to skip prompts).'
        exit 1
    }

    $sel = Read-Host 'Select sandbox(es) to remove — numbers (e.g. "1 3"), "a" = all, "q" = cancel'
    if ([string]::IsNullOrWhiteSpace($sel) -or $sel -match '^[qQ]$') { Write-Host 'intentic: cancelled — nothing removed.'; exit 0 }
    if ($sel -match '^[aA]$') {
        $targets = $slugs
    } else {
        foreach ($tok in ($sel -split '\s+' | Where-Object { $_ })) {
            if ($tok -notmatch '^\d+$') { Write-Warning "ignoring invalid selection '$tok'."; continue }
            $idx = [int]$tok
            if ($idx -lt 1 -or $idx -gt $slugs.Count) { Write-Warning "ignoring out-of-range selection '$tok'."; continue }
            $targets += $slugs[$idx - 1]
        }
    }
}

$targets = @($targets | Where-Object { $_ })
if ($targets.Count -eq 0) { Write-Host 'intentic: nothing selected — nothing removed.'; exit 0 }

Write-Host 'intentic: about to PERMANENTLY DELETE these sandbox(es) and their data (/work + /history):'
$targets | ForEach-Object { Write-Host "    $_" }
Write-Host 'This cannot be undone.'
if (-not (Confirm-Action 'Proceed?')) { Write-Host 'intentic: cancelled — nothing removed.'; exit 0 }

foreach ($s in $targets) { Remove-Slug $s }
Write-Host "intentic: done. Remaining sandboxes: $((Get-Sandboxes) -join ' ')"
