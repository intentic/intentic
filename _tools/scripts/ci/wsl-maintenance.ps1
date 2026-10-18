#Requires -Version 5.1
<#
    wsl-maintenance.ps1 - keeps WSL's virtual disks from eating the Windows system drive on a
    machine that hosts the WSL CI fleet (omen).

    Installed as C:\ProgramData\wsl-maintenance\wsl-maintenance.ps1 (an admin-only folder, because
    the tasks run it elevated) and run, elevated, as the interactive user that owns the distros
    (WSL registrations live in that user's HKCU hive) by two scheduled tasks:
      "WSL Docker Space Guard"   hourly at :20   -Mode guard
      "WSL Docker Maintenance"   daily at 05:30  -Mode routine
    docs/ops/ci-runner.md ("Keeping the WSL disks small") says how to install a new version.

    How space gets back to Windows. A VHDX grows when the guest writes and does not shrink when
    it deletes. Two things give the space back:
      - sparse: the VHDX is an NTFS sparse file, and a TRIM from the guest punches a hole in it,
        so the file's allocation follows what the guest really uses, with no downtime. The CI
        distro mounts its root with `discard` and trims as it deletes. Docker Desktop's data
        disk is mounted without it, so every pass here runs fstrim in both. WSL 3.0.2 made
        sparse VHDs available again (experimental; 2.5.6 to 3.0.1 hid them behind
        --allow-unsafe after ext4 corruption reports). A disk that is not sparse is converted
        in its next compaction window, and needs no compaction after that.
      - compaction: Docker Desktop stopped, `wsl --shutdown`, diskpart `compact vdisk`. That
        is about 10 minutes with WSL down, and every CI job in flight fails, so it runs only
        for a disk that is not sparse, holds -CompactSlackGB of freed space and is not in a
        CI job, in -QuietHours, and at most once per -CompactBackoffHours. A system drive
        below -CompactFreeGB lifts the hours rule, and -Mode panic lifts every rule.

    Modes:
      guard   - hourly: fstrim; prune docker when its disk passes -DockerBudgetGB; prune
                everything when C: drops below -PanicFreeGB; compact when a disk qualifies.
      routine - daily: prune stale docker artefacts, clear old Windows temp, fstrim, report
                each disk, compact when a disk qualifies.
      panic   - remove everything reclaimable and compact regardless of jobs and hours.

    Never removed: a container carrying the dev.intentic.kind label (an Intentic sandbox or runner,
    even a stopped one), its image and its volumes, or any other volume named intentic-* outside
    -Mode panic. That covers the trashed sandboxes `ic sandbox restore` brings back.

    History: 2026-09-27 CI-safe (no compaction during a job; docker integration restored
    afterwards); 2026-10-01 compaction on request of the fleet janitor; 2026-10-16 sparse disks,
    hourly fstrim, compaction decided by freed space instead of free space on C:, images
    pruned after 48h instead of 7 days. The previous version is kept beside the installed copy
    as wsl-maintenance.ps1.bak-<date>.
#>
[CmdletBinding()]
param(
    [ValidateSet('guard', 'routine', 'panic')][string]$Mode = 'guard',
    # Below this much free space on C:, prune every unused image, container and build cache.
    [int]$PanicFreeGB = 50,
    # Below this much free space on C:, a qualifying compaction may run outside -QuietHours.
    [int]$CompactFreeGB = 80,
    # A disk that is not sparse is compacted once it holds this much freed space.
    [int]$CompactSlackGB = 50,
    # No second compaction within this many hours, unless C: is below -CompactFreeGB.
    [int]$CompactBackoffHours = 20,
    # Local hours in which a compaction may run: "start-end", end exclusive.
    [string]$QuietHours = '1-7',
    # The hourly guard prunes images older than a day once docker's disk holds more than this.
    [int]$DockerBudgetGB = 120,
    [int]$BuildCacheGB = 20,
    [int]$ImageMaxAgeHours = 48,
    [string]$JanitorFlag = '/var/lib/intentic-ci/compact-requested',
    [string]$JanitorUnit = 'intentic-ci-janitor.service',
    [switch]$NoCompact,
    [switch]$NoSparse
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Root = 'C:\ProgramData\wsl-maintenance'
$LogFile = Join-Path $Root 'maintenance.log'
$LockFile = Join-Path $Root '.lock'
$LastCompactFile = Join-Path $Root 'last-compact'
$SysDrive = 'C:'
$DockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$DockerDisk = Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'
# The label KEY, not kind=sandbox: a runner (kind=runner) is a stopped container too, and on 2026-10-16 the
# daily prune deleted omen's, leaving its volumes and enrollment behind with nothing to boot them.
$IntenticKindLabel = 'dev.intentic.kind'

if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }

Add-Type -Namespace WslMaintenance -Name Native -ErrorAction SilentlyContinue -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);
'@

# Writes straight to the console handle: Write-Output would inject log lines into
# the return value of every function that logs.
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0}  {1,-5}  {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { [Console]::WriteLine($line) } catch { }
    try {
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 2MB)) {
            Move-Item $LogFile "$LogFile.1" -Force -ErrorAction SilentlyContinue
        }
        Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue
    }
    catch { }
}

function Get-FreeGB {
    [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$SysDrive'").FreeSpace / 1GB, 2)
}

# Docker can hang hard when the disk is full; never let that wedge the scheduled task.
function Invoke-Docker {
    param([string[]]$DockerArgs, [int]$TimeoutSec = 900, [switch]$Quiet)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'docker'
    $psi.Arguments = ($DockerArgs -join ' ')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    try { $p = [System.Diagnostics.Process]::Start($psi) }
    catch { Write-Log "docker $($psi.Arguments) -> cannot start: $_" 'WARN'; return $null }
    # Read both pipes while waiting: a chatty command fills one and never exits.
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        Write-Log "docker $($psi.Arguments) -> timed out after ${TimeoutSec}s, killing" 'WARN'
        try { $p.Kill() } catch { }
        return $null
    }
    $out = $outTask.Result
    $err = $errTask.Result
    if ($p.ExitCode -ne 0) {
        $first = (($err + $out) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
        Write-Log ("docker {0} -> FAILED: {1}" -f $psi.Arguments, $first) 'WARN'
        return $null
    }
    if (-not $Quiet) {
        $tail = (($out + $err) -split "`r?`n" | Where-Object { $_ -match 'Total reclaimed|Total:' } | Select-Object -Last 1) -join ' | '
        Write-Log ("docker {0} -> {1}" -f $psi.Arguments, $(if ($tail) { $tail.Trim() } else { 'ok' }))
    }
    return $out
}

function Test-EngineUp {
    $null -ne (Invoke-Docker -DockerArgs @('version', '--format', '"{{.Server.Version}}"') -TimeoutSec 60 -Quiet)
}

# wsl.exe emits UTF-16LE; without this the names come back NUL-separated.
function Get-WslDistros {
    param([switch]$Running)
    $prev = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
        if ($Running) { $out = & wsl.exe --list --running --quiet 2>$null }
        else { $out = & wsl.exe --list --quiet 2>$null }
        $code = $LASTEXITCODE
    }
    finally { [Console]::OutputEncoding = $prev }
    # With nothing running, wsl.exe prints a sentence and exits non-zero; that is not a name.
    if ($code -ne 0 -or -not $out) { return @() }
    ($out -join "`n") -replace "`0", '' -split "`r?`n" |
        ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

# wsl.exe's own messages are UTF-16LE too (a command run inside a distro prints UTF-8).
function Invoke-WslManage {
    param([string[]]$WslArgs)
    $prev = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
        $out = (& wsl.exe @WslArgs 2>&1 | Out-String) -replace "`0", ''
        $code = $LASTEXITCODE
    }
    finally { [Console]::OutputEncoding = $prev }
    [pscustomobject]@{ Code = $code; Text = (($out -split "`r?`n" | Where-Object { $_.Trim() }) -join ' ').Trim() }
}

# A CI job in flight must never have its containers pulled out from under it.
# The runners on this machine are mostly Linux processes inside WSL, which Get-Process
# cannot see, so every RUNNING distro is asked too (a stopped one is not booted for it).
function Test-RunnerBusy {
    if ($null -ne (Get-Process -Name 'Runner.Worker' -ErrorAction SilentlyContinue)) { return $true }
    foreach ($d in (Get-WslDistros -Running)) {
        if ($d -like 'docker-desktop*') { continue }
        & wsl.exe -d $d -u root -e pgrep -x Runner.Worker 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Log "a CI job is running in WSL distro $d"; return $true }
    }
    return $false
}

# Docker Desktop's WSL integration is what puts /var/run/docker.sock into a distro.
# After a Docker Desktop restart it can fail ("setup groups") and then waits for a click
# in its error dialog, forever. Returns the integrated distros where docker does not answer.
function Get-IntegratedDistros {
    try { @((Get-Content (Join-Path $env:APPDATA 'Docker\settings-store.json') -Raw | ConvertFrom-Json).IntegratedWslDistros) | Where-Object { $_ } }
    catch { @() }
}

function Get-DistrosWithoutDocker {
    $running = @(Get-WslDistros -Running)
    $broken = @()
    foreach ($d in (Get-IntegratedDistros)) {
        if ($running -notcontains $d) { continue }
        & wsl.exe -d $d -e sh -c 'test -S /var/run/docker.sock && timeout 15 docker version --format x >/dev/null 2>&1' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $broken += $d }
    }
    return $broken
}

function Wait-DockerInDistros {
    param([int]$TimeoutSec = 240)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $broken = @(Get-DistrosWithoutDocker)
        if ($broken.Count -eq 0) { return @() }
        Start-Sleep -Seconds 10
    } while ((Get-Date) -lt $deadline)
    return $broken
}

# "default" is a context, not a builder - buildx rejects it. Node rows repeat names.
function Get-Builders {
    $out = Invoke-Docker -DockerArgs @('buildx', 'ls', '--format', '"{{.Name}}"') -TimeoutSec 120 -Quiet
    if (-not $out) { return @() }
    $out -split "`r?`n" |
        ForEach-Object { $_.Trim().Trim('"') } |
        Where-Object { $_ -and $_ -ne 'NAME/NODE' -and $_ -ne 'default' } |
        Select-Object -Unique
}

# ---- the disks ------------------------------------------------------------------------------

# What the file takes on C:. For a sparse file that is less than its length.
function Get-AllocatedGB {
    param([string]$Path)
    $high = [uint32]0
    $low = [WslMaintenance.Native]::GetCompressedFileSizeW($Path, [ref]$high)
    if ($low -eq [uint32]::MaxValue -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 0) {
        return [math]::Round((Get-Item -LiteralPath $Path -Force).Length / 1GB, 2)
    }
    [math]::Round(((([uint64]$high) -shl 32) + $low) / 1GB, 2)
}

function Test-Sparse {
    param([string]$Path)
    (([int](Get-Item -LiteralPath $Path -Force).Attributes) -band [int][IO.FileAttributes]::SparseFile) -ne 0
}

# What the guest's filesystem says it uses, or $null when the distro is not running (a stopped
# distro is never booted just to measure it).
function Get-UsedGB {
    param([string]$Distro, [string]$Mount)
    $out = (& wsl.exe -d $Distro -u root -e df -k $Mount 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { return $null }
    $last = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    $f = @($last.Trim() -split '\s+')
    # Filesystem 1K-blocks Used Available Use% Mounted-on (coreutils and busybox alike)
    if ($f.Count -ge 6) { return [math]::Round(([double]$f[2]) * 1KB / 1GB, 2) }
    return $null
}

# Docker's data disk is mounted only inside Docker Desktop's own namespaces, not in the one
# `wsl -d docker-desktop` opens, so it is reached through a container: /var/lib/docker of the
# engine lives on it. fstrim needs CAP_SYS_ADMIN, hence --privileged for the trim.
$TrimImage = 'alpine:3'
function Get-DockerUsedGB {
    $out = Invoke-Docker @('run', '--rm', '-v', '/var/lib/docker:/t:ro', $TrimImage, 'df', '-k', '/t') -TimeoutSec 180 -Quiet
    if (-not $out) { return $null }
    $f = @((($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()) -split '\s+')
    if ($f.Count -ge 6) { return [math]::Round(([double]$f[2]) * 1KB / 1GB, 2) }
    return $null
}

# Every VHDX of 2 GB or more this user owns: each registered distro's disk, and Docker
# Desktop's data disk (mounted in the docker-desktop distro at /mnt/docker-desktop-disk).
function Get-Disks {
    $running = @(Get-WslDistros -Running)
    $disks = @()
    $entries = @()
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($p.BasePath -and $p.DistributionName) {
            $entries += [pscustomobject]@{ Name = $p.DistributionName; Path = (Join-Path ($p.BasePath -replace '^\\\\\?\\', '') 'ext4.vhdx'); Kind = 'distro'; Distro = $p.DistributionName; Mount = '/' }
        }
    }
    $entries += [pscustomobject]@{ Name = 'docker-data'; Path = $DockerDisk; Kind = 'docker'; Distro = 'docker-desktop'; Mount = '/mnt/docker-desktop-disk' }
    foreach ($e in $entries) {
        if (-not (Test-Path -LiteralPath $e.Path)) { continue }
        $alloc = Get-AllocatedGB $e.Path
        if ($alloc -lt 2) { continue }
        if ($e.Kind -eq 'docker') {
            $isRunning = Test-EngineUp
            $used = if ($isRunning) { Get-DockerUsedGB } else { $null }
        }
        else {
            $isRunning = $running -contains $e.Distro
            $used = if ($isRunning) { Get-UsedGB $e.Distro $e.Mount } else { $null }
        }
        $slack = if ($null -ne $used) { [math]::Round([math]::Max(0, $alloc - $used), 2) } else { $null }
        $disks += [pscustomobject]@{
            Name = $e.Name; Path = $e.Path; Kind = $e.Kind; Distro = $e.Distro; Mount = $e.Mount
            Running = $isRunning; Sparse = (Test-Sparse $e.Path); AllocGB = $alloc; UsedGB = $used; SlackGB = $slack
        }
    }
    return $disks
}

function Format-Disk {
    param($Disk)
    $used = if ($null -ne $Disk.UsedGB) { "$($Disk.UsedGB)GB used inside" } else { 'not running' }
    '{0}: {1}GB on C:, {2}, {3}' -f $Disk.Name, $Disk.AllocGB, $used, $(if ($Disk.Sparse) { 'sparse' } else { 'NOT sparse' })
}

# Hands freed blocks back: to Windows at once on a sparse disk, to the next compaction otherwise.
# Only running distros: the guard must not boot one, nor start Docker Desktop's.
function Invoke-Trim {
    param($Disks)
    foreach ($d in $Disks) {
        if (-not $d.Running) { continue }
        if ($d.Kind -eq 'docker') {
            $out = Invoke-Docker @('run', '--rm', '--privileged', '-v', '/var/lib/docker:/t', $TrimImage, 'fstrim', '-v', '/t') -TimeoutSec 600 -Quiet
            if ($null -ne $out) { Write-Log ("trim: {0}: {1}" -f $d.Name, $out.Trim()) }
            continue
        }
        # Only the first line: wsl.exe's own errors come wrapped in a PowerShell error record.
        $lines = @(& wsl.exe -d $d.Distro -u root -e fstrim -v $d.Mount 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
        $code = $LASTEXITCODE
        $out = if ($lines.Count -gt 0) { $lines[0] } else { '' }
        if ($code -eq 0) { Write-Log ("trim: {0}: {1}" -f $d.Name, $out) }
        else { Write-Log ("trim: {0}: FAILED: {1}" -f $d.Name, $out) 'WARN' }
    }
}

# Needs the disk detached (WSL shut down). The distros go through wsl.exe, which keeps its
# registration in step; Docker's data disk is not a distro, and the flag is all WSL sets anyway.
function Set-DiskSparse {
    param($Disk)
    if ($Disk.Kind -eq 'distro') {
        $r = Invoke-WslManage @('--manage', $Disk.Distro, '--set-sparse', 'true')
        $said = $r.Text
    }
    else {
        $said = ((& fsutil.exe sparse setflag $Disk.Path 1 2>&1 | Out-String) -split "`r?`n" | Where-Object { $_.Trim() }) -join ' '
    }
    $marker = Get-SparseFailedFile $Disk
    if (Test-Sparse $Disk.Path) {
        Write-Log ("sparse: {0} is now sparse ({1})" -f $Disk.Name, $said)
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Log ("sparse: {0} could not be made sparse: {1}" -f $Disk.Name, $said) 'WARN'
        Set-Content -LiteralPath $marker -Value $said -Force
    }
}

# A conversion that failed is not retried for a week: each attempt costs a compaction window.
function Get-SparseFailedFile { param($Disk) Join-Path $Root ("sparse-failed-{0}" -f $Disk.Name) }
function Test-SparseRecentlyFailed {
    param($Disk)
    $f = Get-SparseFailedFile $Disk
    (Test-Path -LiteralPath $f) -and (Get-Item -LiteralPath $f).LastWriteTime -gt (Get-Date).AddDays(-7)
}

# ---- docker -----------------------------------------------------------------------------------

# Unused volumes, except an Intentic sandbox's (intentic-*): a trashed sandbox keeps its data in
# them for `ic sandbox restore`. A stopped sandbox's own volumes are in use and never listed.
function Remove-UnusedVolumes {
    param([switch]$IncludeIntentic)
    $out = Invoke-Docker @('volume', 'ls', '-q', '--filter', 'dangling=true') -TimeoutSec 120 -Quiet
    if ($null -eq $out) { return }
    $names = @($out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and ($IncludeIntentic -or $_ -notlike 'intentic-*') })
    if ($names.Count -eq 0) { Write-Log 'volumes: none unused'; return }
    for ($i = 0; $i -lt $names.Count; $i += 50) {
        $batch = $names[$i..([math]::Min($i + 49, $names.Count - 1))]
        Invoke-Docker (@('volume', 'rm') + $batch) -Quiet | Out-Null
    }
    Write-Log ("volumes: removed {0} unused" -f $names.Count)
}

function Invoke-BuilderPrune {
    param([long]$CapBytes)
    foreach ($b in (Get-Builders)) {
        Invoke-Docker @('buildx', 'prune', '--builder', $b, '--force', '--max-used-space', "$CapBytes") | Out-Null
    }
}

# light: the guard over docker's budget. routine: the daily sweep. aggressive: C: is low.
function Invoke-Prune {
    param([ValidateSet('light', 'routine', 'aggressive', 'panic')][string]$Level)

    if (-not (Test-EngineUp)) { Write-Log 'docker engine not responding; skipping prune' 'WARN'; return }
    $keepSandboxes = "label!=$IntenticKindLabel"
    switch ($Level) {
        'light' {
            Write-Log 'pruning: light (unused images older than 24h, build cache capped)'
            Invoke-Docker @('image', 'prune', '-af', '--filter', 'until=24h') | Out-Null
            Invoke-BuilderPrune ($BuildCacheGB * 1GB)
        }
        'routine' {
            Write-Log "pruning: routine (stopped containers > 24h, unused images > ${ImageMaxAgeHours}h, build cache capped at ${BuildCacheGB}GB, unused volumes)"
            Invoke-Docker @('container', 'prune', '-f', '--filter', 'until=24h', '--filter', $keepSandboxes) | Out-Null
            Invoke-Docker @('image', 'prune', '-af', '--filter', "until=${ImageMaxAgeHours}h") | Out-Null
            Invoke-BuilderPrune ($BuildCacheGB * 1GB)
            Remove-UnusedVolumes
        }
        default {
            Write-Log "pruning: $Level (every stopped container but Intentic sandboxes and runners, every unused image, all build cache, unused volumes)" 'WARN'
            Invoke-Docker @('container', 'prune', '-f', '--filter', $keepSandboxes) | Out-Null
            Invoke-Docker @('image', 'prune', '-af') | Out-Null
            Invoke-BuilderPrune 0
            Remove-UnusedVolumes -IncludeIntentic:($Level -eq 'panic')
        }
    }
}

function Clear-WindowsTemp {
    $cut = (Get-Date).AddDays(-7)
    foreach ($p in @($env:TEMP, 'C:\Windows\Temp', 'C:\Windows\SoftwareDistribution\Download')) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cut } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Write-Log 'cleared Windows temp older than 7 days'
}

# ---- compaction -------------------------------------------------------------------------------

# Why a compaction is wanted, one line per disk; nothing when none is. A sparse disk never
# needs one: trim already gave its space back.
function Get-CompactReasons {
    param($Disks, [double]$Free, [string[]]$Requests)
    $reasons = @()
    foreach ($d in $Disks) {
        if ($d.Sparse) {
            if ($null -ne $d.SlackGB -and $d.SlackGB -ge $CompactSlackGB) {
                Write-Log ("{0} is sparse but takes {1}GB more on C: than it uses after a trim; trim is not reclaiming" -f $d.Name, $d.SlackGB) 'WARN'
            }
            continue
        }
        if ($null -ne $d.SlackGB -and $d.SlackGB -ge $CompactSlackGB) { $reasons += ("{0} holds {1}GB of freed space" -f $d.Name, $d.SlackGB) }
        elseif ($Free -lt $CompactFreeGB -and ($null -eq $d.SlackGB -or $d.SlackGB -ge 5)) { $reasons += ("C: is below {0}GB and {1} is not sparse" -f $CompactFreeGB, $d.Name) }
        elseif ($Requests.Count -gt 0 -and $d.Kind -eq 'distro') { $reasons += ("the CI fleet janitor asked ({0})" -f ($Requests -join ' | ')) }
        elseif (-not $NoSparse -and -not (Test-SparseRecentlyFailed $d) -and $null -ne $d.SlackGB -and $d.SlackGB -ge 10) { $reasons += ("{0} is not sparse yet ({1}GB to reclaim)" -f $d.Name, $d.SlackGB) }
    }
    return $reasons
}

function Test-QuietHour {
    $parts = $QuietHours -split '-'
    $start = [int]$parts[0]; $end = [int]$parts[1]; $h = (Get-Date).Hour
    if ($start -le $end) { return ($h -ge $start -and $h -lt $end) }
    return ($h -ge $start -or $h -lt $end)
}

function Get-HoursSinceCompact {
    if (-not (Test-Path -LiteralPath $LastCompactFile)) { return [double]::MaxValue }
    ((Get-Date) - (Get-Item -LiteralPath $LastCompactFile).LastWriteTime).TotalHours
}

# Returns the reason a compaction may not run now, or nothing when it may.
function Get-CompactBlocker {
    param([double]$Free)
    if ($NoCompact) { return 'suppressed by -NoCompact' }
    if ($Mode -eq 'panic') { return $null }
    $critical = $Free -lt $CompactFreeGB
    $since = Get-HoursSinceCompact
    if (-not $critical -and $since -lt $CompactBackoffHours) { return ("the last one was {0:N1}h ago (backoff {1}h)" -f $since, $CompactBackoffHours) }
    if (-not $critical -and -not (Test-QuietHour)) { return "outside quiet hours $QuietHours" }
    if (Test-RunnerBusy) { return 'a CI job is running' }
    return $null
}

# Returns freed blocks to Windows. Requires WSL fully shut down, hence disruptive.
function Invoke-Compact {
    param($Disks)
    $before = Get-FreeGB
    Write-Log "compact: starting (free ${before}GB)"
    Set-Content -LiteralPath $LastCompactFile -Value (Get-Date -Format o) -Force

    Invoke-Trim $Disks

    Write-Log 'compact: stopping Docker Desktop and shutting down WSL'
    Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs', 'docker', 'dockerd', 'docker-agent' -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 8
    & wsl.exe --shutdown
    Start-Sleep -Seconds 15

    foreach ($d in $Disks) {
        $sizeBefore = Get-AllocatedGB $d.Path
        if (-not $d.Sparse) {
            $tmp = Join-Path $env:TEMP ("dp_{0}.txt" -f [guid]::NewGuid().ToString('N'))
            @(
                "select vdisk file=`"$($d.Path)`""
                'attach vdisk readonly'
                'compact vdisk'
                'detach vdisk'
                'exit'
            ) | Set-Content -LiteralPath $tmp -Encoding Ascii
            $dp = (& diskpart.exe /s $tmp 2>&1 | Out-String)
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            if ($dp -match 'DiskPart has encountered an error|Access is denied|in use') {
                Write-Log ("compact: {0} FAILED - {1}" -f $d.Name, (($dp -split "`r?`n" | Where-Object { $_ -match 'error|denied|in use' } | Select-Object -First 1))) 'WARN'
            }
            else {
                Write-Log ("compact: {0}  {1}GB -> {2}GB" -f $d.Name, $sizeBefore, (Get-AllocatedGB $d.Path))
            }
        }
        if (-not $NoSparse -and -not (Test-Sparse $d.Path)) { Set-DiskSparse $d }
    }

    if (Test-Path -LiteralPath $DockerExe) {
        Write-Log 'compact: restarting Docker Desktop'
        Start-Process -FilePath $DockerExe
        Restore-DockerIntegration
    }
    Write-Log ("compact: done (free {0}GB -> {1}GB)" -f $before, (Get-FreeGB))
}

# The engine answering on Windows is not enough: the CI runners reach it through the
# integration socket inside their distro, which a restart can leave missing for hours.
function Restore-DockerIntegration {
    $deadline = (Get-Date).AddMinutes(5)
    while (-not (Test-EngineUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 10 }
    if (-not (Test-EngineUp)) { Write-Log 'compact: docker engine not up 5 min after restart' 'WARN'; return }

    # Boot the integrated distros now, with the engine already up, so the integration
    # is applied to a distro that is running rather than one still starting.
    foreach ($d in (Get-IntegratedDistros)) { & wsl.exe -d $d -u root -e /bin/true 2>&1 | Out-Null }

    $broken = @(Wait-DockerInDistros -TimeoutSec 240)
    if ($broken.Count -eq 0) { Write-Log 'compact: docker answers inside every integrated distro'; return }

    Write-Log ("compact: no docker inside {0} - restarting Docker Desktop to re-apply the WSL integration" -f ($broken -join ', ')) 'WARN'
    $cli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $cli) { & $cli desktop restart 2>&1 | Out-Null }
    $broken = @(Wait-DockerInDistros -TimeoutSec 240)
    if ($broken.Count -eq 0) { Write-Log 'compact: docker answers inside every integrated distro after the restart' }
    else { Write-Log ("compact: STILL no docker inside {0}; the CI fleet watchdog will keep trying" -f ($broken -join ', ')) 'WARN' }
}

# ---- the CI fleet janitor ---------------------------------------------------------------------

# fleet-janitor.sh leaves -JanitorFlag in its distro after a pass that freed a lot. Only RUNNING
# distros are asked, so the hourly guard never boots one. Returns "<distro>: <flag text>" lines.
function Get-CompactRequests {
    $found = @()
    foreach ($d in (Get-WslDistros -Running)) {
        if ($d -like 'docker-desktop*') { continue }
        $text = (& wsl.exe -d $d -u root -e cat $JanitorFlag 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $text) { $found += ("{0}: {1}" -f $d, (($text -split "`r?`n") -join '; ')) }
    }
    return $found
}

function Clear-CompactRequests {
    foreach ($d in (Get-WslDistros -Running)) {
        if ($d -like 'docker-desktop*') { continue }
        & wsl.exe -d $d -u root -e rm -f $JanitorFlag 2>$null | Out-Null
    }
}

# Low on space: have the janitor take its caps now rather than at its next hourly slot.
function Start-Janitor {
    foreach ($d in (Get-WslDistros -Running)) {
        if ($d -like 'docker-desktop*') { continue }
        & wsl.exe -d $d -u root -e systemctl start --no-block $JanitorUnit 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Log "started $JanitorUnit in $d" }
    }
}

# ---- main -------------------------------------------------------------------------------------

# One instance at a time; a stale lock older than 3h is assumed dead. The CI fleet task reads
# the pid in it and skips its passes while it is held (setup-wsl-fleet.ps1 -MaintenanceLock).
if (Test-Path -LiteralPath $LockFile) {
    if ((Get-Item $LockFile).LastWriteTime -gt (Get-Date).AddHours(-3)) {
        Write-Log 'another run is in progress; exiting' 'WARN'
        exit 0
    }
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -LiteralPath $LockFile -Value $PID -Force

try {
    $free = Get-FreeGB
    Write-Log "=== mode=$Mode free=${free}GB ==="

    $low = ($Mode -eq 'panic') -or ($free -lt $PanicFreeGB)
    if ($low -and $Mode -ne 'panic') { Write-Log "free space below ${PanicFreeGB}GB - escalating" 'WARN' }
    if ($low) { Start-Janitor }

    $disks = @(Get-Disks)
    if ($low) { Invoke-Prune -Level $(if ($Mode -eq 'panic') { 'panic' } else { 'aggressive' }) }
    elseif ($Mode -eq 'routine') { Invoke-Prune -Level routine }
    else {
        $docker = $disks | Where-Object { $_.Kind -eq 'docker' } | Select-Object -First 1
        if ($docker -and $null -ne $docker.UsedGB -and $docker.UsedGB -gt $DockerBudgetGB) {
            Write-Log ("docker's disk holds {0}GB (budget {1}GB)" -f $docker.UsedGB, $DockerBudgetGB)
            Invoke-Prune -Level light
        }
    }
    if ($Mode -ne 'guard') { Clear-WindowsTemp }

    Invoke-Trim $disks
    $disks = @(Get-Disks)
    $free = Get-FreeGB
    if ($Mode -ne 'guard' -or $low) { foreach ($d in $disks) { Write-Log ('disk ' + (Format-Disk $d)) } }

    # A request only matters for a disk that is not sparse: on a sparse one the trim above was it.
    $requests = @(Get-CompactRequests)
    if ($requests.Count -gt 0 -and -not ($disks | Where-Object { $_.Kind -eq 'distro' -and -not $_.Sparse })) {
        Write-Log ("the CI fleet janitor asked for a compaction ({0}); the distro disks are sparse, so the trim returned it" -f ($requests -join ' | '))
        Clear-CompactRequests
        $requests = @()
    }

    $reasons = @(Get-CompactReasons -Disks $disks -Free $free -Requests $requests)
    if ($Mode -eq 'panic' -and $reasons.Count -eq 0) { $reasons = @('-Mode panic') }
    if ($reasons.Count -eq 0) {
        if ($Mode -ne 'guard') { Write-Log 'no disk needs a compaction' }
    }
    else {
        $blocker = Get-CompactBlocker -Free $free
        if ($blocker) {
            Write-Log ("compaction wanted ({0}), not now: {1}" -f ($reasons -join '; '), $blocker)
        }
        else {
            Write-Log ("compaction: {0}" -f ($reasons -join '; '))
            Invoke-Compact -Disks $disks
            # Restore-DockerIntegration booted the integrated distros again, so the flag is reachable.
            if ($requests.Count -gt 0) { Clear-CompactRequests }
            foreach ($d in @(Get-Disks)) { Write-Log ('disk ' + (Format-Disk $d)) }
        }
    }

    Write-Log ("=== done free={0}GB ===" -f (Get-FreeGB))
}
finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
