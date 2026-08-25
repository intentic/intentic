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

# THE FOLDER THE ic CLI LANDS IN, PUT ON THE USER'S PATH - so `ic sandbox doctor <slug>`, `ic sandbox remove
# <slug>` and every other command ic prints when it finishes are real commands rather than a promise the
# installer that made them cannot keep. The .sh twin gets this free with a symlink into ~/.local/bin; Windows
# has no such folder, so the user's own PATH is the only place to say it. Every Windows installer here carries
# an identical copy - they are standalone irm|iex files and cannot share code, so a test in the desktop crate
# holds the copies to each other.
#
# HKCU\Environment is written DIRECTLY rather than through [Environment]::SetEnvironmentVariable, which stores
# the value back as REG_SZ: every %USERPROFILE%- or %PNPM_HOME%-style entry already in that PATH would stop
# expanding, and each tool behind one would vanish from the user's shell - a far worse bug than the one this
# fixes, and the first machine tried had two such entries. Reading with DoNotExpandEnvironmentNames keeps them
# as tokens, and the value goes back under the kind it already had.
#
# Best-effort: PATH is the convenience, the install is the job. A machine that refuses the edit is told where
# the binary is and keeps everything else.
function Add-IntenticPath {
    param([string]$Folder, [string]$Command)
    try {
        $key = Get-Item -Path 'HKCU:\Environment' -ErrorAction Stop
        $stored = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (($stored -split ';') -notcontains $Folder) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $kept = @($stored -split ';' | Where-Object { $_ -ne '' })
            Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value (($kept + $Folder) -join ';') -Type $kind -ErrorAction Stop
            # Explorer hands every terminal it starts a COPY of the environment, taken when Explorer itself
            # started. Without this broadcast - the one the Control Panel's environment editor sends - the new
            # PATH would reach nothing until the next sign-in. SendMessageTimeout, so one wedged window on this
            # desktop cannot wedge an install.
            if (-not ('Intentic.Native' -as [type])) {
                $signature = '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr word, string text, uint flags, uint timeout, out UIntPtr answer);'
                Add-Type -Namespace 'Intentic' -Name 'Native' -MemberDefinition $signature -ErrorAction Stop
            }
            $answer = [UIntPtr]::Zero
            [void][Intentic.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$answer)
        }
        # This window has its own copy as well, and it is the one the user is looking at when the setup output
        # tells them what to run next.
        if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
    } catch {
        Write-Warning "Could not put $Folder on your PATH ($($_.Exception.Message)). Run $Command from that folder, or add it to your PATH yourself."
    }
}

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
        Add-IntenticPath -Folder $IcDir -Command 'ic'
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
