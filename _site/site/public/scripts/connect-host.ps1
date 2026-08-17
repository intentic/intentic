<#
.SYNOPSIS
  intentic connect-host (Windows) - enroll THIS Windows PC as a deploy target for an existing intentic sandbox.

.DESCRIPTION
  The Windows counterpart of connect-host.sh. Windows can't be a native SSH+Docker target, so - exactly like
  connect.ps1's SELF_HOST path - a Docker-in-Docker "host" container (its own dockerd + sshd) becomes the deploy
  target and the sandbox deploys onto THAT over SSH. Unlike connect.ps1 (where the sandbox runs alongside the
  target and reaches it by container name on a shared network), the sandbox here is REMOTE, so we expose the
  target's sshd over its OWN Cloudflare tunnel (ssh-<id>.<zone>) - a cloudflared container that SHARES the DinD's
  network namespace, so the tunnel's `ssh://localhost:22` origin resolves to the DinD's sshd - then self-register
  with the sandbox's daemon via POST /enroll (authed by the connection token). It does NOT create or recreate a
  sandbox - that already exists from setup. Requires Docker Desktop in Linux-containers mode.

  CF_TOKEN creates this host's tunnel + DNS on your zone (ZONE optional - a token that names exactly one zone
  resolves it), which is the form the Infra screen hands you: a deploy target is reached over SSH, and intentic's
  own tunnels carry web traffic. A tunnel minted elsewhere can be handed in directly instead, as
  HOST_SSH_TUNNEL_TOKEN + HOST_SSH_HOSTNAME.

  Reboot survival is weaker than the Linux host (no systemd): the DinD + connector are `--restart unless-stopped`
  containers, so they only come back if Docker Desktop auto-starts on login. Re-run this command to restore them.

.EXAMPLE
  $env:SANDBOX_URL='https://sandbox-<id>.<zone>'; $env:CONNECT_TOKEN='<token>'; $env:CF_TOKEN='<cf>'; $env:ZONE='<zone>'; irm https://intentic.dev/connect-host.ps1 | iex

.EXAMPLE
  $env:SANDBOX_URL='...'; $env:CONNECT_TOKEN='...'; $env:HOST_SSH_TUNNEL_TOKEN='...'; $env:HOST_SSH_HOSTNAME='ssh-<id>.<zone>'; $env:HOST_NAME='server1'; irm https://intentic.dev/connect-host.ps1 | iex
#>
param(
    [string]$SandboxUrl,
    [string]$ConnectToken,
    [string]$HostName
)
# docker probes below are expected to exit non-zero; we branch on $LASTEXITCODE ourselves. NOT 'Stop', because
# Windows PowerShell 5.1 turns a redirected native stderr into a terminating error and every quiet probe here
# would end the run on the outcome it exists to detect (see connect.ps1 for the whole story).
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# Explicit params (direct file invocation) win; else the env vars the `irm | iex` one-liner carries.
if (-not $SandboxUrl) { $SandboxUrl = $env:SANDBOX_URL }
if (-not $ConnectToken) { $ConnectToken = $env:CONNECT_TOKEN }
if (-not $HostName) { $HostName = $env:HOST_NAME }
$CfToken = $env:CF_TOKEN
$Zone = $env:ZONE
# Pre-provisioned host tunnel (intentic-provided sandboxes): the platform minted the tunnel + DNS under its zone
# and the one-liner carries the connector token + hostname - no Cloudflare token, no tunnel creation here.
$HostSshTunnelToken = $env:HOST_SSH_TUNNEL_TOKEN
$HostSshHostname = $env:HOST_SSH_HOSTNAME
$ProvidedTunnel = [bool]$HostSshTunnelToken -and [bool]$HostSshHostname
# The DinD "host" image (its own dockerd + sshd) is the actual deploy target; the sandbox image carries the CLI
# that mints the own-Cloudflare host tunnel. Both track the latest release like connect.ps1.
$DindImage = if ($env:DIND_IMAGE) { $env:DIND_IMAGE } else { 'ghcr.io/intentic/dind-host:latest' }
$SandboxImage = if ($env:SANDBOX_IMAGE) { $env:SANDBOX_IMAGE } else { 'ghcr.io/intentic/sandbox:stable' }
$CloudflaredImage = if ($env:CLOUDFLARED_IMAGE) { $env:CLOUDFLARED_IMAGE } else { 'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf' }
# The key is generated INSIDE the DinD (root-owned), so the sandbox always logs in as root - the user supplies none.
$HostUser = 'root'
$HostSshKey = ''

function Normalize-HostName([string]$Value) {
    $Name = $Value.Trim().ToLowerInvariant() -replace '[^a-z0-9_]', '_'
    if (-not $Name) { return '' }
    if ($Name -match '^[0-9]') { $Name = "_$Name" }
    if ($Name -eq 'self') { return 'host' }
    return $Name
}

# ---- required inputs ----
if (-not $SandboxUrl) { Write-Error 'SANDBOX_URL is required - copy the one-liner from the Infra screen.'; exit 1 }
if (-not $ConnectToken) { Write-Error 'CONNECT_TOKEN is required - copy the one-liner from the Infra screen.'; exit 1 }
# CF_TOKEN only creates the host tunnel - a pre-provisioned one makes it unnecessary.
if (-not $ProvidedTunnel -and -not $CfToken) {
    Write-Error 'CF_TOKEN is required - Cloudflare exposes this deploy target''s SSH to your sandbox. Create a token at https://dash.cloudflare.com/profile/api-tokens with Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit.'
    exit 1
}
# The pre-provisioned path requires an explicit HOST_NAME: the minted tunnel id was salted with the name picked
# on the Infra screen, so a machine-name default here would silently desync from it.
if ($ProvidedTunnel -and -not $HostName) {
    Write-Error 'HOST_NAME is required with a pre-provisioned tunnel - copy the one-liner from the Infra screen.'
    exit 1
}
# Normalize explicit HOST_NAME to the same deploy.config identifier shape the Infra screen shows; default to this
# machine's name when the own-Cloudflare path omits it.
if ($HostName) {
    $HostName = Normalize-HostName $HostName
}
if (-not $HostName) {
    if ($ProvidedTunnel) {
        Write-Error 'HOST_NAME could not be normalized to a deploy target id - copy the one-liner from the Infra screen.'
        exit 1
    }
    $HostName = Normalize-HostName "$env:COMPUTERNAME"
    if (-not $HostName) { $HostName = 'host' }
}

# Pull a published image, clearing a stale ghcr.io login and retrying anonymously on failure (images are public).
function Invoke-ImagePull([string]$Image) {
    Write-Host "intentic: pulling $Image (first run can take a minute)..."
    docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'intentic: pull failed - clearing a stale ghcr.io login and retrying anonymously...'
        docker logout ghcr.io *> $null
        docker pull $Image
        if ($LASTEXITCODE -ne 0) {
            # The stale-login guess has been cleared and the anonymous retry failed too, so an
            # "unauthorized"/"denied" here means the package is refused to everyone - ours to fix, not the
            # user's (a GHCR package is private until made public by hand; see publish-images.sh).
            Write-Host "intentic: $Image could not be pulled without a login - an ""unauthorized"" or ""denied"" above means"
            Write-Host '          its registry package is not public, which is a packaging fault on our side. Report it, or if'
            Write-Host '          this org is yours make the package public at https://github.com/orgs/intentic/packages.'
            Write-Error "failed to pull $Image (see the docker output above)."
            exit 1
        }
    }
}

# ---- fetch the ic CLI (the same block connect.ps1 and recreate.ps1 carry, apart from its one narration
#      line - a test in desktop-app/src-tauri/src/scripts.rs holds the three to that, because three
#      hand-kept copies of a download are three chances to drift) ----
# Downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a failed download
# falls back to what's installed. IC_BIN overrides for local dev. Download-then-rename: overwriting a running
# executable fails, and a half-downloaded binary must never be what runs.
$Ic = $env:IC_BIN
if (-not $Ic) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    Write-Host 'intentic: [fetching-ic] fetching the ic CLI...'
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

# ---- Docker, and everything Windows needs before Docker can exist ----
# This was a copy of connect.ps1's Docker block, kept in step by hand and marked "lifted from connect.ps1".
# Both are now one call into ic, which examines this PC properly (virtualization, WSL2, the features behind
# it, a pending restart, Docker, its group, its engine, its container mode, free space), asks once, and fixes
# what it can. See connect.ps1 for why that reading lives there rather than in a shell script.
& $Ic docker prepare
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ---- validate the Cloudflare token (own-Cloudflare path only; lifted from connect.ps1) ----
if (-not $ProvidedTunnel) {
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

# Per-(sandbox, host) identity, so one PC can host several targets and re-running the same command reuses this
# one (same DinD volume => deployed containers/state survive). Digest matches the tunnel-id scheme (token:name).
$slugInput = '{0}:{1}' -f $ConnectToken, $HostName
$sha = [System.Security.Cryptography.SHA256]::Create()
$Slug = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($slugInput))) -replace '-', '').Substring(0, 12).ToLower()
$DindContainer = "intentic-dind-host-$Slug"
$DindVolume = "intentic-dind-docker-$Slug"
$TunnelContainer = "intentic-host-ssh-tunnel-$Slug"

Invoke-ImagePull $DindImage
if (-not $ProvidedTunnel) { Invoke-ImagePull $SandboxImage }

# ---- stand up the Docker-in-Docker deploy target + its SSH key (lifted from connect.ps1) ----
Write-Host 'intentic: starting the Docker-in-Docker deploy target...'
docker rm -f $DindContainer *> $null
docker run -d --privileged --restart unless-stopped --name $DindContainer `
    -e DOCKER_TLS_CERTDIR= `
    -v "${DindVolume}:/var/lib/docker" `
    --dns 1.1.1.1 --dns 1.0.0.1 `
    $DindImage | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the Docker-in-Docker deploy target (see the docker output above).'
    exit 1
}
# Wait until `docker exec` works, then generate a fresh ed25519 key inside the target and authorize it as the
# target's only key (root-owned, 600 - sshd rejects loose modes). The private half is read out for the sandbox.
for ($i = 0; $i -lt 60; $i++) { docker exec $DindContainer true *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
docker exec $DindContainer sh -c 'ssh-keygen -t ed25519 -N "" -C intentic-host -f /root/.ssh/intentic_ed25519 >/dev/null && cat /root/.ssh/intentic_ed25519.pub > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to provision the deploy target''s SSH key (see the docker output above).'
    exit 1
}
$HostSshKey = (docker exec $DindContainer cat /root/.ssh/intentic_ed25519) -join "`n"

# ---- expose the target's sshd over Cloudflare ----
if ($ProvidedTunnel) {
    Write-Host "intentic: using the pre-provisioned host SSH tunnel ($HostSshHostname)."
    $HostAddress = $HostSshHostname
} else {
    Write-Host "intentic: creating this host's SSH tunnel..."
    $tunnelArgs = @('run', '--rm', '--entrypoint', 'intentic', '-e', "CLOUDFLARE_API_TOKEN=$CfToken", '-e', "CONNECT_TOKEN=$ConnectToken", '-e', "HOST_NAME=$HostName")
    if ($Zone) { $tunnelArgs += @('-e', "ZONE=$Zone") }
    $tunnelArgs += @($SandboxImage, 'tunnel', 'host')
    $hostSshOut = & docker $tunnelArgs
    $HostSshTunnelToken = ($hostSshOut | Where-Object { $_ -like 'HOST_SSH_TUNNEL_TOKEN=*' } | Select-Object -First 1) -replace '^HOST_SSH_TUNNEL_TOKEN=', ''
    $HostAddress = ($hostSshOut | Where-Object { $_ -like 'HOST_SSH_HOSTNAME=*' } | Select-Object -First 1) -replace '^HOST_SSH_HOSTNAME=', ''
    if (-not $HostSshTunnelToken -or -not $HostAddress) {
        Write-Error 'failed to create this host''s SSH tunnel (see the output above).'
        exit 1
    }
}

# The connector SHARES the DinD's network namespace (--network container:), so the tunnel's `ssh://localhost:22`
# origin is the DinD's own sshd - no origin rewrite needed. Coupling: recreating the DinD orphans this connector
# (both are recreated together on a re-run).
Write-Host 'intentic: starting the host SSH tunnel connector...'
docker rm -f $TunnelContainer *> $null
docker run -d --restart unless-stopped --name $TunnelContainer --network "container:$DindContainer" `
    $CloudflaredImage tunnel --no-autoupdate run --token $HostSshTunnelToken | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error 'failed to start the host SSH tunnel connector (see the docker output above).'
    exit 1
}

# ---- enroll with the sandbox (mirrors connect-host.sh's POST /enroll) ----
Write-Host 'intentic: enrolling with the sandbox...'
$body = @{
    name    = $HostName
    user    = $HostUser
    address = $HostAddress
    port    = 22
    via     = 'cloudflared'
    sshKey  = $HostSshKey
}
# cfToken rides along only on the own-Cloudflare path - the pre-provisioned one has no token to hand over.
if ($CfToken) { $body.cfToken = $CfToken }
try {
    Invoke-RestMethod -Method Post -Uri "$SandboxUrl/enroll" `
        -Headers @{ 'x-intentic-connect' = $ConnectToken } `
        -ContentType 'application/json' `
        -Body ($body | ConvertTo-Json -Compress) | Out-Null
} catch {
    Write-Error "enroll failed ($($_.Exception.Message)). Is the sandbox reachable at $SandboxUrl and is the DevOps capability active?"
    exit 1
}

Write-Host "intentic: this machine is enrolled as deploy target ""$HostName"" (SSH reachable at $HostAddress)."
Write-Host 'Provision from the Infra screen to deploy onto it. Re-run this command anytime to refresh the key/tunnel.'
Write-Host "Logs: docker logs -f $DindContainer"
Write-Host "Stop (keeps deployed state): docker stop $DindContainer $TunnelContainer"
