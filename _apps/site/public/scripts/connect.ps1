<#
.SYNOPSIS
  intentic connect (Windows) — run the AI-agent workspace sandbox on THIS PC and expose it to your
  browser, so a user without their own server can drive a project from their machine.

.DESCRIPTION
  The platform mints a per-project connection token and hands you a one-liner. This creates the
  sandbox's OWN Cloudflare tunnel (sandbox-<id>.<zone> → the daemon, plus *.preview.<zone> → the app
  preview), starts the published sandbox image as a long-lived, UNPRIVILEGED container (no Docker
  socket), and runs a cloudflared sidecar. The browser then talks to the sandbox DIRECTLY over that
  tunnel — the daemon verifies your Google sign-in, and the platform stays off the command path. The
  setup screen binds the sandbox's public URL itself and probes it until the daemon answers.
  Setup is reachability-only. To later deploy an app onto this PC, the platform's "Deploy on
  this machine" action re-runs with $env:SELF_HOST='1', which stands up a Docker-in-Docker "host"
  container the sandbox deploys onto over SSH (Windows can't be a native SSH+Docker target). Requires
  Docker Desktop in Linux-containers mode (the sandbox image is Linux). Desktop sync chosen at setup
  carries the local folder as $env:SYNC_DIR on the command while SYNC_PAIR_TOKEN rides the setup-code
  claim: when SYNC_DIR is set, once the sandbox is up this also runs the standard sync bootstrap (never
  fatal to sandbox setup).

.EXAMPLE
  $env:SETUP_CODE='<code>'; irm https://intentic.dev/connect.ps1 | iex                        # intentic-provided tunnel

.EXAMPLE
  $env:CF_TOKEN='<cf>'; $env:SETUP_CODE='<code>'; irm https://intentic.dev/connect.ps1 | iex  # own Cloudflare

.EXAMPLE
  ./connect.ps1 -ConnectToken <token>   # headless/scripted: raw values, no setup code
#>
param(
    [string]$PlatformUrl,
    [string]$ConnectToken,
    [string]$SetupCode,
    # Start without prompting even if other sandboxes are already running (the old always-proceed behavior).
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
# Native commands (docker) are expected to exit non-zero on the probes below; we branch on $LASTEXITCODE
# ourselves. Disable the PS 7.4+ default that turns those non-zero exits into terminating errors.
$PSNativeCommandUseErrorActionPreference = $false

# Prefer explicit params (direct file invocation); fall back to env vars (the `irm | iex` one-liner path).
# PlatformUrl is the platform's API origin where the setup code is redeemed (POST /setup/claim) — NOT the web-app
# origin (app.*), which serves only static files. A single hosted domain (never self-hosted), so it defaults to
# the API host. LOCAL DEV ONLY: to test against a platform on your own machine, pass -PlatformUrl
# http://localhost:<apiPort> — never shown in the product UI.
if (-not $PlatformUrl) { $PlatformUrl = if ($env:PLATFORM_URL) { $env:PLATFORM_URL } else { 'https://api.intentic.dev' } }
if (-not $ConnectToken) { $ConnectToken = $env:CONNECT_TOKEN }
if (-not $SetupCode) { $SetupCode = $env:SETUP_CODE }
# The latest RELEASE image via the moving `stable` tag (pulled fresh below), never :latest — see connect.sh for
# why (the :latest/hand-tagged builds carry internal version 0.0.0, whose @intentic/* deps are unpublished, so
# `intentic init` can't resolve them; the release only ever moves `stable` onto a published release image).
$SandboxImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'registry.gitlab.com/radarsu/intentic/sandbox:stable' }
# The daemon's preview proxy port, exposed at *.preview.<zone>; apps declare their own ports in apps.json.
$PreviewPort = if ($env:PREVIEW_PORT) { $env:PREVIEW_PORT } else { '5173' }
# Dev QoL (see connect.sh): a named volume or absolute host path mounted at /agent-auth and passed as
# AGENT_AUTH_DIR, so the AI-provider OAuth stores are shared across sandboxes and survive resets. A localhost
# platform injects it into the one-liner; empty (production) ⇒ credentials stay in the workspace volume.
$AgentAuthVolume = $env:INTENTIC_AGENT_AUTH_VOLUME
# Infra secrets `intentic apply` reads inside the sandbox; they ride into the sandbox container's env and are
# never sent to the platform. CF_TOKEN (your Cloudflare API token) is REQUIRED — Cloudflare is intentic's
# reachability fabric (the tunnel that connects services, exposes them, AND carries browser→sandbox traffic);
# it is validated below and passed to the sandbox as the Cloudflare-standard CLOUDFLARE_API_TOKEN the CLI reads.
$CfToken = $env:CF_TOKEN
# Self-host: unlike Linux (where the box you ran this on becomes the deploy target), Windows can't be a native
# SSH+Docker target, so a Docker-in-Docker "host" container below is the deploy target and we deploy onto THAT.
# DEFAULT OFF — setup is reachability-only; set `$env:SELF_HOST='1'` (the platform's "Deploy on this machine"
# action) to stand it up. SELF_HOST_ADDRESS/SELF_HOST_USER/HOST_SSH_KEY are derived from that container below —
# the user never supplies an SSH key.
$SelfHost = $env:SELF_HOST
$HostSshKey = ''
$SelfHostUser = ''
$SelfHostAddress = ''
# Browser-direct access: the sandbox is exposed at sandbox-<id>.<zone> via its OWN Cloudflare tunnel and the
# browser talks to it directly — the daemon verifies the user's Google ID token (audience = GOOGLE_CLIENT_ID, the
# platform's PUBLIC web client id, hardcoded here since it's a static platform value; env can override). WEB_ORIGIN,
# when set, scopes the daemon's CORS (else open — the Google-token audience is the real gate); ZONE picks the zone.
$GoogleClientId = if ($env:GOOGLE_CLIENT_ID) { $env:GOOGLE_CLIENT_ID } else { '481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com' }
$WebOrigin = $env:WEB_ORIGIN
$Zone = $env:ZONE
$CloudflaredImage = if ($env:CLOUDFLARED_IMAGE) { $env:CLOUDFLARED_IMAGE } else { 'cloudflare/cloudflared:2026.6.1' }
# The platform can PRE-PROVISION the tunnel (intentic-provided path, for users with no Cloudflare of their own):
# it fills $env:TUNNEL_TOKEN + $env:SANDBOX_HOSTNAME into the one-liner instead of CF_TOKEN. When both are set we
# skip all Cloudflare API work and just run the sandbox + cloudflared with the given connector token. $Subdomain
# is the optional custom prefix for the self-provision (own-Cloudflare) path.
$TunnelToken = $env:TUNNEL_TOKEN
$SandboxHostname = $env:SANDBOX_HOSTNAME
$Subdomain = $env:SUBDOMAIN
# Desktop sync chosen at setup: SYNC_DIR (the local folder) rides the command; SYNC_PAIR_TOKEN rides the claim.
# The pair token is seeded into the sandbox at boot as a single-use pairing, then handed to the sync bootstrap.
$SyncDir = $env:SYNC_DIR
$SyncPairToken = $env:SYNC_PAIR_TOKEN
$SandboxPublicUrl = ''

Write-Host 'intentic: checking Docker...'
$DockerInstalled = $false
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    # Best-effort guided install: winget can install Docker Desktop, but a first WSL2 setup may require a
    # reboot — the daemon wait below names that remedy. Never silent: consent (naming Docker's terms) first.
    if ($env:INSTALL_DOCKER -ne '1') {
        $answer = Read-Host 'intentic: Docker Desktop is not installed. Install it now via winget? Continuing accepts Docker''s terms (https://www.docker.com/legal/docker-subscription-service-agreement) [Y/n]'
        if ($answer -match '^[nN]') {
            Write-Error 'docker is required — install Docker Desktop (https://docs.docker.com/get-docker/) and re-run.'
            exit 1
        }
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error 'docker is not installed and winget is unavailable — install Docker Desktop (https://docs.docker.com/get-docker/), then re-run.'
        exit 1
    }
    Write-Host 'intentic: installing Docker Desktop (winget, ~500 MB)...'
    winget install --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Docker Desktop install failed — install it manually (https://docs.docker.com/get-docker/), then re-run.'
        exit 1
    }
    # A fresh install isn't on this session's PATH yet; point at the standard install location and launch it.
    $env:Path += ";$env:ProgramFiles\Docker\Docker\resources\bin"
    $dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerDesktop) { Start-Process $dockerDesktop }
    $DockerInstalled = $true
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    if (-not $DockerInstalled) {
        Write-Error 'the docker daemon is not running. Start Docker Desktop, then re-run.'
        exit 1
    }
    Write-Host 'intentic: waiting for Docker Desktop (accept the first-run dialog if shown)...'
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 5
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'the Docker daemon did not come up — if Windows asked to reboot (WSL2 setup), reboot and re-run this command.'
        exit 1
    }
}

# The platform's one-liner carries ONE short-lived setup code instead of raw tokens (nothing secret lands in
# shell history); redeem it for the per-sandbox values — CONNECT_TOKEN plus either the pre-provisioned tunnel
# (intentic path) or the zone/subdomain picks (own-Cloudflare path), as KEY=value lines. Env vars still work
# without a code (headless/scripted installs). Redeemed after the Docker step so a docker-missing failure
# never burns time against the code's TTL.
if ($SetupCode) {
    Write-Host 'intentic: redeeming the setup code...'
    # LOCAL DEV ONLY: the dev platform's cert is a repo CA the system doesn't trust, so localhost claims skip
    # TLS verification — never for real domains.
    $claimArgs = @{ Method = 'Post'; Uri = "$PlatformUrl/setup/claim"; Body = @{ code = $SetupCode } }
    if ($PlatformUrl -match '^https?://(localhost|127\.0\.0\.1)') { $claimArgs.SkipCertificateCheck = $true }
    try {
        $claim = Invoke-RestMethod @claimArgs
    } catch {
        Write-Error "could not redeem the setup code at $PlatformUrl ($($_.Exception.Message)) — refresh the platform's setup page and copy a fresh command."
        exit 1
    }
    foreach ($line in ($claim -split "`n")) {
        $line = $line.Trim()
        if ($line -like 'CONNECT_TOKEN=*') { $ConnectToken = $line.Substring('CONNECT_TOKEN='.Length) }
        elseif ($line -like 'TUNNEL_TOKEN=*') { $TunnelToken = $line.Substring('TUNNEL_TOKEN='.Length) }
        elseif ($line -like 'SANDBOX_HOSTNAME=*') { $SandboxHostname = $line.Substring('SANDBOX_HOSTNAME='.Length) }
        elseif ($line -like 'ZONE=*') { $Zone = $line.Substring('ZONE='.Length) }
        elseif ($line -like 'SUBDOMAIN=*') { $Subdomain = $line.Substring('SUBDOMAIN='.Length) }
        # SYNC_DIR is NOT claimed — it's the user's local folder opt-in, carried on the command as $env:SYNC_DIR.
        elseif ($line -like 'SYNC_PAIR_TOKEN=*') { $SyncPairToken = $line.Substring('SYNC_PAIR_TOKEN='.Length) }
    }
}
$ProvidedTunnel = [bool]$TunnelToken -and [bool]$SandboxHostname

# Per-sandbox identity, so several sandboxes coexist on one machine. The slug is the same key the public hostname
# uses: an explicit SUBDOMAIN, else a platform-provided hostname's leftmost label, else the connect-token digest
# that forms sandbox-<id>. So distinct tokens get distinct container/volume/network (which persist the cloned repos
# and let the tunnel ingress + cloudflared sidecar resolve by DNS), while re-running with the same token replaces
# just that one.
if ($Subdomain) {
    $Slug = $Subdomain
} elseif ($ProvidedTunnel) {
    $Slug = $SandboxHostname.Split('.')[0]
} else {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $Slug = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($ConnectToken))) -replace '-', '').Substring(0, 12).ToLower()
}
$Container = "intentic-sandbox-$Slug"
$WorkspaceVolume = "intentic-workspace-$Slug"
# Snapshot history + protected repo git dirs live on their own volume, mounted OUTSIDE /work so agent accidents
# in the workspace can't destroy them.
$HistoryVolume = "intentic-history-$Slug"
# The in-sandbox Docker Engine's /var/lib/docker: a named volume so pulled images and dev-DB volumes survive
# recreates — and layers land on a real filesystem (overlay2), not overlayfs-on-overlayfs.
$DockerVolume = "intentic-docker-$Slug"
$Network   = "intentic-workspace-$Slug"
$TunnelContainer = "intentic-sandbox-tunnel-$Slug"
# The stable name the tunnel ingress dials. The workspace answers to it via a --network-alias on its own per-sandbox
# network, so the real container name stays unique (coexistence) while BOTH the platform-provisioned tunnel (whose
# ingress origin is fixed to this name) and the own-Cloudflare tunnel below reach the daemon by one constant.
$OriginHost = 'intentic-sandbox-workspace'
# The Docker-in-Docker deploy target (when self-host is on): its own dockerd + sshd, reached by the sandbox at this
# container name on the per-sandbox network. Per-slug too, so self-hosting sandboxes don't fight over one target.
$DindContainer = "intentic-dind-host-$Slug"
$DindImage = if ($env:DIND_IMAGE) { $env:DIND_IMAGE } else { 'registry.gitlab.com/radarsu/intentic/dind-host:latest' }
$DindVolume = "intentic-dind-docker-$Slug"

# CONNECT_TOKEN is the per-user value the setup code redeems into (or env/-ConnectToken carries directly).
if (-not $ConnectToken) {
    Write-Error 'CONNECT_TOKEN is required (via the setup code, env var, or -ConnectToken) — copy the one-liner from the platform''s setup screen.'
    exit 1
}
# Intentic-provided sandboxes (pre-provisioned tunnel, no CF_TOKEN) are reachability-only — SELF_HOST's deploy
# target needs your OWN Cloudflare token at apply time. Fail fast with a clear message.
if ($ProvidedTunnel -and $SelfHost) {
    Write-Error 'SELF_HOST needs your own Cloudflare API token (CF_TOKEN). Intentic-provided sandboxes are reachability-only — add your own Cloudflare from the workspace to deploy onto this PC.'
    exit 1
}
# Cloudflare is intentic's reachability fabric (the tunnel that connects services and exposes them), so the
# token is required and validated up front rather than failing later at `intentic apply`. It never reaches the
# platform — it rides into the sandbox below. Verify it against Cloudflare's token-verify endpoint.
if (-not $ProvidedTunnel -and -not $CfToken) {
    Write-Error 'CF_TOKEN is required — Cloudflare is intentic''s reachability fabric (the tunnel that connects your services and exposes them). Create a token at https://dash.cloudflare.com/profile/api-tokens with Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit.'
    exit 1
}
# Validate the token only when the user supplied one (own-Cloudflare path); the intentic-provided path has none.
if ($CfToken) {
    Write-Host 'intentic: validating Cloudflare API token...'
    try {
        $cfVerify = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Headers @{ Authorization = "Bearer $CfToken" }
    } catch {
        $cfVerify = $null
    }
    if (-not $cfVerify -or -not $cfVerify.success -or $cfVerify.result.status -ne 'active') {
        Write-Error 'the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens.'
        exit 1
    }
}

# ── coexistence check (helpers duplicated in cleanup.ps1 — this script runs standalone via `irm | iex`, keep in
# lockstep) ─────────────────────────────────────────────────────────────────────────────────────────────────────
function Test-Interactive { [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }
function Get-Sandboxes {
    @(docker ps -a --filter 'name=intentic-sandbox-' --format '{{.Names}}' 2>$null) |
        Where-Object { $_ -and $_ -notlike 'intentic-sandbox-tunnel-*' } |
        ForEach-Object { $_ -replace '^intentic-sandbox-', '' }
}
# A PC can host several sandboxes at once (each suffixed by its own slug). If OTHER sandboxes already exist, don't
# silently start one more beside them — surface them and let the user continue, clean some up first, or quit. A
# same-slug re-run is a normal reset (replaces just that one), so the current slug is excluded. Skipped with -Yes;
# with no console to prompt on we proceed (an explicitly requested create must not block automation).
if (-not $Yes) {
    $others = @(Get-Sandboxes | Where-Object { $_ -ne $Slug })
    if ($others.Count -gt 0) {
        Write-Host "intentic: you already have $($others.Count) other sandbox(es) on this PC:"
        foreach ($s in $others) {
            $st = (docker inspect -f '{{.State.Status}}' "intentic-sandbox-$s" 2>$null)
            if (-not $st) { $st = '?' }
            Write-Host ('  {0,-9} {1}' -f $st, $s)
        }
        if (Test-Interactive) {
            Write-Host 'This starts a NEW sandbox alongside them.'
            Write-Host '  [c] continue (start alongside)'
            Write-Host '  [r] remove some first...'
            Write-Host '  [q] quit'
            $choice = Read-Host 'Choose [c/r/q]'
            if ($choice -match '^[rR]') {
                $CleanupScriptUrl = if ($env:CLEANUP_SCRIPT_URL) { $env:CLEANUP_SCRIPT_URL } else { 'https://intentic.dev/cleanup.ps1' }
                Write-Host 'intentic: opening cleanup...'
                try { & ([scriptblock]::Create((Invoke-RestMethod $CleanupScriptUrl))) } catch { Write-Warning "cleanup did not run: $($_.Exception.Message)" }
                Write-Host 'intentic: continuing with this sandbox...'
            } elseif ($choice -match '^[qQ]' -or [string]::IsNullOrWhiteSpace($choice)) {
                Write-Host 'intentic: aborted — no sandbox started.'
                exit 0
            }
            # c (or anything else) => start alongside
        } else {
            Write-Warning 'no console to prompt — starting alongside them (pass -Yes to silence, or run cleanup first).'
        }
    }
}

# Make the sandbox image runnable (mirrors connect.sh's ensure_image). A registry-less tag (local dev:
# intentic-sandbox:dev) can only resolve to Docker Hub, so it is never pulled - it is rebuilt from the checkout
# this script lives in on EVERY run, not just when missing: a cached image would otherwise silently outlive
# Dockerfile or source edits, and docker's layer cache makes an unchanged rebuild near-instant. ($PSScriptRoot
# is empty on the irm|iex path - no checkout there, so that path runs an existing local image as-is, or errors.)
# Registry images are pulled even when cached so the moving `stable` tag always runs the newest release. The
# image is PUBLIC; if a stale Docker Desktop `docker login registry.gitlab.com` makes the pull "denied", clear
# it and retry anonymously.
$FirstSegment = ($SandboxImage -split '/', 2)[0]
$HasRegistry = $SandboxImage.Contains('/') -and ($FirstSegment -match '[.:]' -or $FirstSegment -eq 'localhost')
if (-not $HasRegistry) {
    $RepoRoot = if ($PSScriptRoot) { Resolve-Path (Join-Path $PSScriptRoot '../../../..') } else { $null }
    $Dockerfile = if ($RepoRoot) { Join-Path $RepoRoot '_apps/sandbox/Dockerfile' } else { $null }
    if (-not $Dockerfile -or -not (Test-Path $Dockerfile)) {
        docker image inspect $SandboxImage *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "intentic: using the existing local sandbox image $SandboxImage (no intentic checkout found to rebuild it from)."
        } else {
            Write-Error "'$SandboxImage' is a local dev tag that isn't built, and no intentic checkout was found to build it from - run 'pnpm build:sandbox' in the repo, or remove SANDBOX_IMAGE to use the published image."
            exit 1
        }
    } else {
        Write-Host "intentic: building the local sandbox image $SandboxImage from your checkout (cached when unchanged; the first build takes a few minutes)..."
        # The Dockerfile compiles OUTSIDE Docker: prepare-image-trees.sh builds the six baked packages into
        # .image-out, consumed by the build as the named context `trees` (COPY --from=trees). A bare
        # `docker build` can't resolve that context and fails, so both steps run together from the repo root.
        Push-Location $RepoRoot
        bash _tools/scripts/prepare-image-trees.sh
        if ($LASTEXITCODE -eq 0) { docker build --build-context trees=.image-out -f _apps/sandbox/Dockerfile -t $SandboxImage . }
        $buildExit = $LASTEXITCODE
        Pop-Location
        if ($buildExit -ne 0) {
            docker image inspect $SandboxImage *> $null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "intentic: building $SandboxImage failed (see the docker output above) - continuing with the PREVIOUS local build, which does NOT include your latest changes."
            } else {
                Write-Error 'building the sandbox image failed (see the docker output above).'
                exit 1
            }
        }
    }
} else {
    Write-Host "intentic: pulling sandbox image $SandboxImage (first run can take a minute)..."
    docker pull $SandboxImage
    if ($LASTEXITCODE -ne 0) {
        docker image inspect $SandboxImage *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'intentic: pull failed but the image exists locally - using the local copy.'
        } else {
            Write-Host 'intentic: pull failed - clearing a stale registry.gitlab.com login and retrying anonymously...'
            docker logout registry.gitlab.com *> $null
            docker pull $SandboxImage
            if ($LASTEXITCODE -ne 0) {
                Write-Error 'failed to pull the sandbox image (see the docker output above).'
                exit 1
            }
        }
    }
}

# Point at the sandbox tunnel (sandbox-<id>.<zone> → the daemon :8787, plus *.preview.<zone> → the preview proxy
# :$PreviewPort on the own-Cloudflare path). Either the platform pre-provisioned it with intentic's token (nothing to
# do), or the bundled CLI creates/refreshes it with the user's token and prints the connector token below.
if ($ProvidedTunnel) {
    $SandboxPublicUrl = "https://$SandboxHostname"
} else {
    Write-Host 'intentic: creating the sandbox tunnel...'
    # --entrypoint intentic: the image's default entrypoint is the daemon; we want the bundled CLI instead.
    $tunnelArgs = @('run', '--rm', '--entrypoint', 'intentic', '-e', "CLOUDFLARE_API_TOKEN=$CfToken", '-e', "CONNECT_TOKEN=$ConnectToken")
    if ($Zone) { $tunnelArgs += @('-e', "ZONE=$Zone") }
    $tunnelArgs += @($SandboxImage, 'sandbox-tunnel', '--service', "http://${OriginHost}:8787", '--preview-service', "http://${OriginHost}:$PreviewPort", '--ssh-service', "ssh://${OriginHost}:22")
    if ($Subdomain) { $tunnelArgs += @('--subdomain', $Subdomain) }
    $tunnelOut = & docker $tunnelArgs
    $TunnelToken = ($tunnelOut | Where-Object { $_ -like 'TUNNEL_TOKEN=*' } | Select-Object -First 1) -replace '^TUNNEL_TOKEN=', ''
    $SandboxHostname = ($tunnelOut | Where-Object { $_ -like 'SANDBOX_HOSTNAME=*' } | Select-Object -First 1) -replace '^SANDBOX_HOSTNAME=', ''
    if (-not $TunnelToken -or -not $SandboxHostname) {
        Write-Error 'failed to create the sandbox tunnel (see the output above).'
        exit 1
    }
    $SandboxPublicUrl = "https://$SandboxHostname"
}

# cloudflared (the sidecar below) reaches the sandbox by container name on this shared network; create it first.
docker network inspect $Network *> $null
if ($LASTEXITCODE -ne 0) { docker network create $Network | Out-Null }
docker rm -f $Container *> $null

# Self-host on Windows = a Docker-in-Docker "host" the sandbox deploys onto over SSH (Windows can't be a native
# SSH+Docker target). The sandbox runs ALONGSIDE it on Docker Desktop, NOT inside it — the control plane stays an
# unprivileged container outside its (privileged) targets, can drive several of them, and outlives any one being
# rebuilt; it reaches this one over SSH exactly like a remote host. Stand it up on the shared network so the
# sandbox resolves it by name; the key is generated INSIDE the target (no Windows ssh-keygen needed, and it stays
# root-owned), and its private half rides into the sandbox as HOST_SSH_KEY. Mirrors _tools/scripts/intentic-local.sh.
if ($SelfHost) {
    Write-Host 'intentic: starting the Docker-in-Docker deploy target...'
    docker rm -f $DindContainer *> $null
    docker run -d --privileged --restart unless-stopped --name $DindContainer `
        --network $Network `
        -e DOCKER_TLS_CERTDIR= `
        -v "${DindVolume}:/var/lib/docker" `
        --dns 1.1.1.1 --dns 1.0.0.1 `
        $DindImage | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'failed to start the Docker-in-Docker deploy target (see the docker output above).'
        exit 1
    }
    # Wait until `docker exec` works, then generate a fresh ed25519 key inside the target and authorize it as the
    # target's only key (root-owned, 600 — sshd rejects loose modes). The private half is read out for the sandbox.
    for ($i = 0; $i -lt 60; $i++) { docker exec $DindContainer true *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
    docker exec $DindContainer sh -c 'ssh-keygen -t ed25519 -N "" -C intentic-dind -f /root/.ssh/intentic_ed25519 >/dev/null && cat /root/.ssh/intentic_ed25519.pub > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'failed to provision the deploy target''s SSH key (see the docker output above).'
        exit 1
    }
    $HostSshKey = (docker exec $DindContainer cat /root/.ssh/intentic_ed25519) -join "`n"
    $SelfHostUser = 'root'
    $SelfHostAddress = $DindContainer
    Write-Host "intentic: deploy target '$DindContainer' is ready (the sandbox reaches it over SSH on the shared network)."
}

# Runs UNPRIVILEGED: container privileges come only from "# intentic:runtime" directives in an owner-approved
# overlay, applied by rebuild.sh on a recreate (the docker capability's --privileged for its ISOLATED nested
# engine, the vpn's tun + NET_ADMIN). The image bakes Docker + Compose but the engine stays dormant until that
# grant; the host's Docker socket is never mounted. --add-host lets it reach the host it runs on at
# host.docker.internal. The workspace volume persists the cloned repos across re-runs. The daemon binds
# 0.0.0.0:8787 on the private network; only the Cloudflare tunnel exposes it (no host port is published).
# SELF_HOST_* (when self-host is on) point the sandbox's `self` deploy target at the Docker-in-Docker host
# above. Every -e value is quoted so spaces and the multi-line HOST_SSH_KEY pass as single arguments.
$AgentAuthArgs = if ($AgentAuthVolume) { @('-v', "${AgentAuthVolume}:/agent-auth", '-e', 'AGENT_AUTH_DIR=/agent-auth') } else { @() }
docker run -d --restart unless-stopped --name $Container `
    --network $Network `
    --network-alias $OriginHost `
    --add-host host.docker.internal:host-gateway `
    -v "${WorkspaceVolume}:/work" `
    -v "${HistoryVolume}:/history" `
    -v "${DockerVolume}:/var/lib/docker" `
    @AgentAuthArgs `
    -e WORKSPACE_ROOT=/work `
    -e HISTORY_ROOT=/history `
    -e SANDBOX_HOST=0.0.0.0 `
    -e SANDBOX_PORT=8787 `
    -e "SANDBOX_NAME=$Container" `
    -e "SANDBOX_IMAGE=$SandboxImage" `
    -e "PREVIEW_PORT=$PreviewPort" `
    -e "GOOGLE_CLIENT_ID=$GoogleClientId" `
    -e "CONNECT_TOKEN=$ConnectToken" `
    -e "WEB_ORIGIN=$WebOrigin" `
    -e "SANDBOX_PUBLIC_URL=$SandboxPublicUrl" `
    -e "CLOUDFLARE_API_TOKEN=$CfToken" `
    -e "SELF_HOST_ADDRESS=$SelfHostAddress" `
    -e "SELF_HOST_USER=$SelfHostUser" `
    -e "HOST_SSH_KEY=$HostSshKey" `
    -e "SYNC_PAIR_TOKEN=$SyncPairToken" `
    $SandboxImage | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the sandbox container (see the docker output above).'
    exit 1
}

# Start the tunnel connector: cloudflared on the shared network routes sandbox-<id>.<zone> → the daemon and
# *.preview.<zone> → the app preview. It retries until the sandbox is up, so ordering is not critical.
Write-Host 'intentic: starting the sandbox tunnel connector...'
docker rm -f $TunnelContainer *> $null
docker run -d --restart unless-stopped --name $TunnelContainer --network $Network `
    $CloudflaredImage tunnel --no-autoupdate run --token $TunnelToken | Out-Null

$StopList = "$Container $TunnelContainer"
if ($SelfHost) { $StopList += " $DindContainer" }
Write-Host 'intentic sandbox started.'
Write-Host "Your sandbox will be reachable at $SandboxPublicUrl (DNS may take a few seconds to propagate)."
Write-Host 'Return to the platform — setup will continue automatically once it connects.'

# Desktop sync chosen at setup: the same paste covers it. Wait for the sandbox over its PUBLIC url (tunnel +
# DNS can take a minute), then run the standard sync bootstrap — never fatal, the sandbox is already up.
# sync.ps1's Write-Error calls throw under Stop (caught here); the agent's own failures land in $LASTEXITCODE.
if ($SyncDir -and $SyncPairToken) {
    Write-Host 'intentic: waiting for your sandbox to come online to set up desktop sync...'
    $syncOk = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            Invoke-RestMethod -Uri "$SandboxPublicUrl/health" -TimeoutSec 5 | Out-Null
            $syncOk = $true
            break
        } catch {
            Start-Sleep -Seconds 3
        }
    }
    if ($syncOk) {
        $env:SANDBOX_URL = $SandboxPublicUrl; $env:PAIR_TOKEN = $SyncPairToken; $env:SYNC_DIR = $SyncDir
        $SyncScriptUrl = if ($env:SYNC_SCRIPT_URL) { $env:SYNC_SCRIPT_URL } else { 'https://intentic.dev/sync.ps1' }
        try {
            irm $SyncScriptUrl | iex
            if ($LASTEXITCODE -ne 0) { $syncOk = $false }
        } catch {
            $syncOk = $false
        }
    }
    if (-not $syncOk) {
        Write-Warning "desktop sync didn't finish. Your sandbox is fine — enable sync any time from the workspace's Desktop sync card."
    }
}

if (-not $SelfHost) {
    Write-Host 'Reachable only — no deploy target. To deploy an app onto this PC later, re-run with $env:SELF_HOST=''1''.'
}
Write-Host "Logs: docker logs -f $Container"
Write-Host "Stop (keeps your /work): docker stop $StopList"
Write-Host "Reset this sandbox (also removes its /work volume): & ([scriptblock]::Create((irm https://intentic.dev/cleanup.ps1))) -Slug $Slug -Yes"
