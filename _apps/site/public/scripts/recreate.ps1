<#
.SYNOPSIS
  intentic recreate (Windows) - swap THIS machine's sandbox container onto a different image, preserving
  /work, /history, the tunnel, and every setting the container carries.

.DESCRIPTION
  The PowerShell twin of recreate.sh, and the same two modes the platform hands out:

    rebuild - the agent proposed .intentic/environment.Dockerfile, the owner approved it in the browser, and
      the Environment card handed over this one-liner. The SHA256 is the trust anchor: the overlay lives on
      the workspace volume the agent can write, so only content that still hashes to what the owner reviewed
      is ever built.
    update - pulls the moving :stable tag and re-applies the approved overlay (if any) onto it, so the
      extended environment carries forward.

  The sandbox holds no HOST Docker socket (its own engine is nested - it cannot recreate its own container),
  which is why both modes run HERE, on the machine that runs the container.

  HOW THE CONTAINER IS RUN is deliberately not written in this file. The docker-run shape (volumes, network,
  capability posture, env allowlist) is the run contract (@intentic/sandbox-run), and the TARGET IMAGE carries
  the CLI that speaks it: this script feeds the old container's env in NUL-framed and splats the argv
  `intentic sandbox run-command --format json` answers with. The contract ships with the image, so this
  script keeps working, unchanged, as the contract evolves.

  There is no -Dev mode here. That one drives the in-repo dogfood loop (dev-sandbox.sh, POSIX sh only), so a
  PowerShell port of it would be an untested path with no callers - run the repo's dev loop under WSL.

  There is no -Rollback or -Channel here yet either, for the same reason and with a real consequence worth
  stating: a Windows host updates onto :stable as it always has, and cannot walk that back with one command.
  recreate.sh grew both (it records the base it replaced beside its logs, and swaps the pair on each rollback
  so pressing it twice returns you), and the daemon reports channel/previousImage on /info regardless of which
  script created the container - so the Update card's rollback offer is simply absent on a Windows-created
  sandbox rather than broken. Porting the pair here is the follow-up; until then the way back on Windows is
  the connect one-liner, which is what it was before.

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/update))) -Slug sandbox-abc123def456

.EXAMPLE
  & ([scriptblock]::Create((irm https://intentic.dev/rebuild))) -Slug sandbox-abc123def456 -Hash <sha256>
#>
param(
    [Parameter(Mandatory = $true)][string]$Slug,
    # Present => rebuild (the approved overlay, pinned to this digest); absent => update (the fresh :stable base).
    [string]$Hash
)
# docker's probes are expected to exit non-zero; we branch on $LASTEXITCODE ourselves. NOT 'Stop', because on
# Windows PowerShell 5.1 that turns a redirected native stderr into a terminating error and every quiet probe
# below becomes a script-killer - connect.ps1's header has the long version.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$RegistryImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'registry.gitlab.com/radarsu/intentic/sandbox:stable' }
$ApprovedFile = '/work/.intentic/environment.approved.Dockerfile'
$Mode = if ($Hash) { 'rebuild' } else { 'update' }
$Container = "intentic-sandbox-$Slug"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error 'docker is required - run this on the machine that runs the sandbox.'
    exit 1
}
docker inspect $Container *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "sandbox container $Container does not exist on this machine - re-run connect first."
    exit 1
}

# Every recreate leaves a log on this machine (build/pull output, the replaced container's tail, launch
# failures) - the `docker rm` below destroys the old container's `docker logs`, so its tail is captured first.
$LogDir = if ($env:INTENTIC_LOG_DIR) { $env:INTENTIC_LOG_DIR } else { Join-Path $env:USERPROFILE '.intentic\logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Get-ChildItem -Path $LogDir -Filter 'recreate-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 9 | Remove-Item -Force -ErrorAction SilentlyContinue
$Log = Join-Path $LogDir "recreate-$Mode-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

# Everything read off the OLD container is read WITHOUT `docker exec`, so a crashed sandbox is still
# recreatable: `docker cp` and `docker inspect` both work on a stopped container. The env comes from
# .Config.Env - the values `docker run` was given plus the image's own ENV, which is what the contract replays.
function Get-ContainerEnv {
    $json = docker inspect --format '{{json .Config.Env}}' $Container
    if ($LASTEXITCODE -ne 0 -or -not $json) { return @() }
    return @($json | ConvertFrom-Json)
}
function Get-ContainerEnvValue([string]$Name) {
    foreach ($pair in Get-ContainerEnv) {
        if ($pair.StartsWith("$Name=")) { return $pair.Substring($Name.Length + 1) }
    }
    return ''
}

# A stale/expired `docker login registry.gitlab.com` (Docker Desktop's credential store) makes docker present
# that token and the registry reject the PUBLIC pull - clear it and retry anonymously.
function Invoke-Pull([string]$Image) {
    docker pull $Image 2>&1 | Tee-Object -FilePath $Log -Append
    if ($LASTEXITCODE -eq 0) { return $true }
    docker image inspect $Image *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'intentic: pull failed but the image exists locally - using the local copy.'
        return $true
    }
    Write-Host 'intentic: pull failed - clearing a stale registry.gitlab.com login and retrying anonymously...'
    docker logout registry.gitlab.com *> $null
    docker pull $Image 2>&1 | Tee-Object -FilePath $Log -Append
    return ($LASTEXITCODE -eq 0)
}

# --- The mode pre-step: produce $TargetImage / $BaseImage / $EnvHash and the overlay file (may be empty). ---
$Overlay = New-TemporaryFile
$EnvHash = ''
try {
    if ($Mode -eq 'rebuild') {
        # Copy the approved overlay out ONCE and hash/build that same copy - byte-exact, with no window
        # between the check and the build.
        docker cp "${Container}:${ApprovedFile}" $Overlay.FullName *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Error 'no approved overlay found in the sandbox - approve the proposal on the Environment card first.'
            exit 1
        }
        $have = (Get-FileHash -Algorithm SHA256 -Path $Overlay.FullName).Hash.ToLowerInvariant()
        if ($have -ne $Hash.ToLowerInvariant()) {
            Write-Error "the approved overlay changed since it was reviewed (expected $Hash, found $have). Re-review and re-approve it on the Environment card, then run the fresh command it shows."
            exit 1
        }
        $EnvHash = $have
    }
    else {
        # Pull the latest base up front - a moved :stable tag is exactly what makes an update available, and
        # `docker run` reuses a cached tag without re-pulling. A no-op pull is reported honestly.
        Write-Host "intentic: pulling $RegistryImage..."
        "== docker pull $RegistryImage ==" | Add-Content -Path $Log
        $beforeId = docker image inspect --format '{{.Id}}' $RegistryImage 2>$null
        Invoke-Pull $RegistryImage | Out-Null
        $afterId = docker image inspect --format '{{.Id}}' $RegistryImage 2>$null
        if ($beforeId -and $beforeId -eq $afterId) {
            Write-Host 'intentic: no newer sandbox image is available yet - your sandbox is already on the latest :stable it can pull.'
            Write-Host '          If the app still shows an update, the new release image may still be publishing - try again in a few minutes.'
            exit 0
        }
        # Re-apply the approved overlay (if any) FROM the fresh base, so the extended environment carries on.
        docker cp "${Container}:${ApprovedFile}" $Overlay.FullName *> $null
        if ($LASTEXITCODE -ne 0) { Clear-Content -Path $Overlay.FullName }
    }

    $OverlayText = Get-Content -Raw -Path $Overlay.FullName -ErrorAction SilentlyContinue
    $HasOverlay = -not [string]::IsNullOrWhiteSpace($OverlayText)

    # The base the overlay extends, checked belt-and-braces (the daemon already enforced it at approval): any
    # OFFICIAL sandbox image, or the exact base this container was created from (SANDBOX_BASE_IMAGE, set at
    # `docker run` by whichever runner made it - not a value the agent can write).
    $BaseImage = ''
    if ($HasOverlay) {
        foreach ($line in ($OverlayText -split "`r?`n")) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
            if ($trimmed -match '^FROM\s+(\S+)') { $BaseImage = $Matches[1] }
            break
        }
        if (-not $BaseImage) {
            Write-Error 'the approved overlay has no FROM instruction.'
            exit 1
        }
        $currentBase = Get-ContainerEnvValue 'SANDBOX_BASE_IMAGE'
        if ($BaseImage -notlike 'registry.gitlab.com/radarsu/intentic/sandbox:?*' -and $BaseImage -ne $currentBase) {
            Write-Error "the approved overlay must start with FROM registry.gitlab.com/radarsu/intentic/sandbox:<tag> (or FROM this sandbox's own base, $currentBase); found $BaseImage."
            exit 1
        }
    }

    # Build the overlay (when there is one) BEFORE touching the container, so a failed build leaves the
    # sandbox running untouched. Stdin build - an overlay is FROM + RUN/ENV only, no build context.
    if ($Mode -eq 'rebuild') {
        $TargetImage = "intentic-sandbox-env-${Slug}:$($EnvHash.Substring(0, 12))"
        Write-Host "intentic: building $TargetImage from the approved overlay..."
        "== docker build $TargetImage ==" | Add-Content -Path $Log
        $OverlayText | docker build -t $TargetImage - 2>&1 | Tee-Object -FilePath $Log -Append
    }
    else {
        $TargetImage = $RegistryImage
        if (-not $BaseImage) { $BaseImage = $RegistryImage }
        if ($HasOverlay) {
            # The full digest pins SANDBOX_ENVIRONMENT_HASH (so the daemon reports the overlay as Applied);
            # its first 12 chars tag the built image - the same derivation the rebuild mode uses.
            $EnvHash = (Get-FileHash -Algorithm SHA256 -Path $Overlay.FullName).Hash.ToLowerInvariant()
            $TargetImage = "intentic-sandbox-env-${Slug}:$($EnvHash.Substring(0, 12))"
            Write-Host 'intentic: rebuilding your environment overlay on the new base...'
            "== docker build --pull $TargetImage ==" | Add-Content -Path $Log
            $OverlayText | docker build --pull -t $TargetImage - 2>&1 | Tee-Object -FilePath $Log -Append
        }
    }
    docker image inspect $TargetImage *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$TargetImage is not available (pull or overlay build failed) - the sandbox is untouched. Log: $Log"
        exit 1
    }

    # --- Ask the TARGET IMAGE for its own run command (see the header): env in, argv out. ---
    # The /agent-auth mount is a mount+env pair: replaying AGENT_AUTH_DIR without its volume would point the
    # daemon at an empty container-local dir, stranding the shared credentials.
    $EnvPairs = @(Get-ContainerEnv)
    # A container's env is fixed for its life, so REPLAYING it means every allowlisted value is immutable
    # until the owner re-runs the whole connect wizard. INTENTIC_SET_ENV is the escape hatch - NAME=VALUE per
    # line, PREPENDED, because the contract resolves each name to its FIRST occurrence.
    if ($env:INTENTIC_SET_ENV) {
        $EnvPairs = @($env:INTENTIC_SET_ENV -split "`r?`n" | Where-Object { $_ }) + $EnvPairs
    }
    $mounts = docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agent-auth"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' $Container 2>$null
    if ($mounts) { $mounts = "${mounts}:/agent-auth" }
    $runtimeLines = if ($HasOverlay) {
        ($OverlayText -split "`r?`n" | Where-Object { $_ -like '# intentic:runtime *' }) -join "`n"
    }
    else { '' }
    # The resolvers the container was created with (connect.sh's SANDBOX_DNS): a restricted-network sandbox
    # loses its split-horizon config the first time it is recreated without them.
    $dns = docker inspect --format '{{join .HostConfig.Dns " "}}' $Container 2>$null

    $VerbArgs = @('sandbox', 'run-command', '--slug', $Slug, '--image', $TargetImage, '--base-image', $BaseImage, '--format', 'json')
    if ($dns) { $VerbArgs += @('--dns', $dns) }
    if ($EnvHash) { $VerbArgs += @('--environment-hash', $EnvHash) }
    if ($runtimeLines) { $VerbArgs += @('--runtime', $runtimeLines) }
    if ($mounts) { $VerbArgs += @('--mounts', $mounts) }
    $EnvStdin = ($EnvPairs -join "`0") + "`0"

    $ArgvJson = $EnvStdin | docker run -i --rm --entrypoint intentic $TargetImage @VerbArgs
    if ($LASTEXITCODE -ne 0 -or -not $ArgvJson) {
        Write-Error "$TargetImage could not produce its run command (an unsupported runtime directive, or an image too old to carry the run contract - run the update flow first). Log: $Log"
        exit 1
    }

    Write-Host "intentic: recreating the sandbox from $TargetImage..."
    "== previous container logs ($Container) ==" | Add-Content -Path $Log
    docker logs --tail 5000 $Container 2>&1 | Add-Content -Path $Log
    docker rm -f $Container *> $null

    # Two attempts, because exactly one part of the run may fail without the sandbox being broken: docker
    # refuses the WHOLE launch when something already holds the loopback shortcut's port, so the retry drops
    # just the shortcut. The failed attempt leaves a created-but-stopped container holding the name.
    docker @($ArgvJson | ConvertFrom-Json) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        docker rm -f $Container *> $null
        $ArgvJson = $EnvStdin | docker run -i --rm --entrypoint intentic $TargetImage @VerbArgs --no-local-publish
        if ($LASTEXITCODE -ne 0 -or -not $ArgvJson) {
            Write-Error "starting the recreated sandbox failed (a runtime flag the host rejects?). Log: $Log. Re-run your connect one-liner to restore the stock sandbox."
            exit 1
        }
        docker @($ArgvJson | ConvertFrom-Json) | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "starting the recreated sandbox failed (see the docker output above). Log: $Log. Re-run your connect one-liner to restore the stock sandbox."
            exit 1
        }
        Write-Host 'intentic: recreated without the local shortcut (its port is taken) - this browser reaches the sandbox over its tunnel.'
    }
}
finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $Overlay.FullName
}

# A container that starts but crash-loops (an overlay that breaks the daemon) would otherwise read as success.
# Two waits, because a daemon that ANSWERS is not yet a daemon that SERVES: it listens the moment the process
# can, then converges its state behind a readiness gate during which every route but /health and /events parks.
Write-Host 'intentic: waiting for the sandbox daemon to come up...'
for ($tries = 0; $tries -lt 15; $tries++) {
    docker exec $Container curl -sf http://localhost:8787/health *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
}
if ($LASTEXITCODE -ne 0) {
    "== recreated container logs ($Container) ==" | Add-Content -Path $Log
    docker logs --tail 500 $Container 2>&1 | Add-Content -Path $Log
    Write-Error "the recreated sandbox did not become healthy within 30s - its logs are saved to $Log. Re-run your connect one-liner to restore the stock sandbox."
    exit 1
}

# The running step's label, echoed as it changes - the same chain the browser's warm-up screen shows. A daemon
# too old to report a boot answers neither field, which reads as "no step running, ready".
$lastStep = ''
for ($waited = 0; $waited -lt 120; $waited++) {
    $health = docker exec $Container curl -sf http://localhost:8787/health 2>$null
    if (-not $health -or $health -notmatch '"ready":false') { break }
    $step = ''
    foreach ($fragment in ($health -split '{')) {
        if ($fragment -match '"state":"running"' -and $fragment -match '"label":"([^"]*)"') { $step = $Matches[1]; break }
    }
    if ($step -and $step -ne $lastStep) {
        Write-Host "intentic:   $step..."
        $lastStep = $step
    }
    Start-Sleep -Seconds 1
}

if ($Mode -eq 'rebuild') {
    Write-Host 'intentic: sandbox rebuilt - the Environment card will show Applied once it reconnects.'
}
else {
    Write-Host "intentic: sandbox updated to $TargetImage."
}
Write-Host "Logs: docker logs -f $Container (recreate log: $Log)"
