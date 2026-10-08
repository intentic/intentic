<#
.SYNOPSIS
  intentic fix (Windows) - bootstrap shim for the one command a sandbox that stopped answering hands out. The work
  itself lives in the `ic` CLI (_sandbox/ic, `ic sandbox fix`): it checks every layer of this machine between you
  and the sandbox (network, Docker Desktop, WSL, the disk, the container, its daemon), fixes what is safe to fix,
  asks in this window before anything disruptive, and says what is left for you. This script only fetches the
  binary and forwards.

  The code is the one the browser's recovery panel put in the command, in $env:FIX_CODE. It names the sandbox and
  lets this run report its progress back to that page; without it the run still fixes, the page just cannot watch
  it. Arguments are ic's own flags (--yes, --accept docker-app), forwarded verbatim.

.EXAMPLE
  $env:FIX_CODE='<code>'; irm https://intentic.dev/fix.ps1 | iex      # the recovery panel's command
.EXAMPLE
  irm https://intentic.dev/fix.ps1 | iex                               # no code: every sandbox here, unobserved
#>
# Only ic's flags, and no named parameter for the code: PowerShell binds a script's first argument to its first
# parameter by position, so `fix.ps1 --auto` would hand ic `--code --auto`.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$IcArgs)
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# Read once and taken out of this window's environment: the variable outlives the command in the user's session,
# and a later hand-typed `ic sandbox fix` would otherwise pick up a code that lapsed half an hour after it was made.
$Code = $env:FIX_CODE
Remove-Item Env:FIX_CODE -ErrorAction SilentlyContinue

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
# Downloaded on every run that pins no release, so re-running a card's command upgrades an existing install;
# a run pinned to a release (IC_VERSION) that finds it or a newer one installed skips it, and only a failed download falls back
# to what's installed. IC_BIN overrides for local dev.
# A pinned run the desktop app started copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is
# exactly the release asked for: the same binary, without the download.
$Ic = $env:IC_BIN
if (-not $Ic) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    # A caller that pins its release (IC_VERSION beside IC_URL, which the desktop app sets to its own) and finds
    # that release OR A NEWER ONE installed has nothing to fetch: asking the binary costs milliseconds, the download
    # seconds. Never "exactly that release": the machine agent moves ic up by itself, so a desktop app left in the
    # tray for days put an older ic back on every Start, Stop or Restart it ran (2026-10-05). Compared as versions,
    # major.minor.patch first, a pre-release below its own release; an installed ic whose answer is not a version
    # is replaced. An unpinned run (the one-liner) still downloads, which is how it upgrades an existing install.
    $IcHave = if ($env:IC_VERSION -and (Test-Path $IcDest)) { (& $IcDest --version | Out-String).Trim() } else { '' }
    $IcCurrent = $false
    if ($IcHave -match '^ic v?(\d+\.\d+\.\d+)(\S*)$') {
        $IcHaveCore = [version]$Matches[1]
        $IcHavePre = $Matches[2]
        if ($env:IC_VERSION -match '^v?(\d+\.\d+\.\d+)(\S*)$') {
            $IcPinCore = [version]$Matches[1]
            $IcCurrent = ($IcHaveCore -gt $IcPinCore) -or ($IcHaveCore -eq $IcPinCore -and (-not $IcHavePre -or $IcHavePre -eq $Matches[2]))
        }
    }
    if ($IcCurrent) {
        Write-Host "note: $IcHave is installed (this run asks for ic $env:IC_VERSION or newer) - not downloading it."
        $Ic = $IcDest
        Add-IntenticPath -Folder $IcDir -Command 'ic'
    } else {
        Write-Host 'intentic: fetching the ic CLI...'
        # THE ic THE DESKTOP APP CARRIES, copied instead of downloaded. The app names the ic its installer put beside
        # it (INTENTIC_IC_PATH) and pins the run to its own release (IC_VERSION), so a copy that answers exactly that
        # release is the very binary the download would fetch, minus the network: a PC that cannot reach github.com
        # still gets its ic. Anything else - no pin, no file, another version, a copy that fails - leaves the download
        # below to run as it always has, and that download is all the irm|iex one-liner ever does.
        $IcCopied = $false
        if ($env:INTENTIC_IC_PATH -and $env:IC_VERSION -and (Test-Path -LiteralPath $env:INTENTIC_IC_PATH -PathType Leaf)) {
            $IcCarried = ''
            try { $IcCarried = (& $env:INTENTIC_IC_PATH --version | Out-String).Trim() } catch { $IcCarried = '' }
            if ($IcCarried -eq ('ic ' + ($env:IC_VERSION -replace '^v', ''))) {
                try {
                    Copy-Item -LiteralPath $env:INTENTIC_IC_PATH -Destination "$IcDest.tmp" -Force -ErrorAction Stop
                    Move-Item -Force "$IcDest.tmp" $IcDest -ErrorAction Stop
                    $IcCopied = $true
                } catch {
                    Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
                }
            }
        }
        if ($IcCopied) {
            Write-Host "note: installed $IcCarried from the copy the desktop app carries - not downloading it."
            $Ic = $IcDest
            Add-IntenticPath -Folder $IcDir -Command 'ic'
        } else {
            # Windows PowerShell 5.1 redraws its progress bar for every chunk Invoke-WebRequest reads, which makes a
            # five-megabyte download take several seconds instead of a fraction of one.
            $ProgressPreference = 'SilentlyContinue'
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
    }
}

# One the platform does not know is ic's to say so; it fixes anyway, only unobserved.
if ($Code) {
    & $Ic sandbox fix --code $Code @IcArgs
} else {
    & $Ic sandbox fix @IcArgs
}
# ic's exit code stays in $LASTEXITCODE either way. `exit` only when this is a script file: pasted (irm | iex) or
# wrapped in a scriptblock, `exit` ends the user's whole PowerShell session, and the window would close on the one
# message that says what is left for them.
if ($PSCommandPath) { exit $LASTEXITCODE }
