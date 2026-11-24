# Get-IntenticIc: the ic CLI to run, found or downloaded. IC_BIN overrides (a checkout's own build). Downloaded on
# every run that pins no release, so re-running a one-liner upgrades a device; a run pinned to a release (IC_VERSION)
# that finds it or a newer one installed skips it, and only a failed download falls back to an installed ic. Download-
# then-rename: overwriting a running executable fails, and a half-downloaded binary must never be what runs. A pinned
# run the desktop app started copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is exactly the
# release asked for. A download is checked against the release's SHA256SUMS before anything runs it; a mismatch is
# deleted unrun and the ic already installed stays.

# Swap aside, never delete first (2026-11-20, intentic#49): Move-Item -Force onto an installed ic deletes it before the
# new one is in, and when Windows then refused the new one (security software holding the folder), a device that had a
# working ic was left with none. So the installed ic is renamed to ic.old.exe (Windows allows renaming a running
# program), the new one takes its name, and a failure puts the old one back before it rethrows. Where Windows refuses
# the name itself, putting it back fails too, so the old one stays as ic.old.exe and Get-IntenticIc runs it from there.
# Leftovers are removed only once ic.exe is a working ic: before that, one of them may be the only ic this device has.
function Get-IntenticIcLeftovers([string]$Dest) {
    $Leaf = [IO.Path]::GetFileNameWithoutExtension($Dest)
    return @(Get-ChildItem -LiteralPath (Split-Path $Dest) -Filter "$Leaf.old*.exe" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}

function Install-IntenticIcFile([string]$From, [string]$Dest) {
    if (Test-IntenticIc $Dest) {
        foreach ($Left in (Get-IntenticIcLeftovers $Dest)) { Remove-Item -Force -LiteralPath $Left -ErrorAction SilentlyContinue }
    }
    $Old = [IO.Path]::ChangeExtension($Dest, '.old.exe')
    # Still there: an ic started from it is running, or it is the only working copy. A name of its own keeps it.
    if (Test-Path -LiteralPath $Old) { $Old = [IO.Path]::ChangeExtension($Dest, '.old-' + [guid]::NewGuid().ToString('N') + '.exe') }
    $Aside = $false
    if (Test-Path -LiteralPath $Dest) {
        Move-Item -LiteralPath $Dest -Destination $Old -ErrorAction Stop
        $Aside = $true
    }
    try {
        Move-Item -LiteralPath $From -Destination $Dest -ErrorAction Stop
    } catch {
        $Refusal = $_
        if ($Aside -and -not (Test-Path -LiteralPath $Dest)) {
            try { Move-Item -LiteralPath $Old -Destination $Dest -ErrorAction Stop } catch { $null = $_ }
        }
        throw $Refusal
    }
    foreach ($Left in (Get-IntenticIcLeftovers $Dest)) { Remove-Item -Force -LiteralPath $Left -ErrorAction SilentlyContinue }
}

# Test-IntenticIcNetwork: the failure is the network's (a name that does not resolve, a refused or reset connection, a
# timeout, an HTTP error) rather than this device's, at any depth. Matched by type name: System.Net.Http is not loaded
# in every Windows PowerShell 5.1 session, and naming one of its types there is itself an error.
function Test-IntenticIcNetwork($Failure) {
    while ($null -ne $Failure) {
        if ($Failure.GetType().FullName -match '^System\.Net\.|HttpResponseException$|TaskCanceledException$|TimeoutException$|AuthenticationException$') { return $true }
        $Failure = $Failure.InnerException
    }
    return $false
}

# Test-IntenticIc: the file starts and answers --version as ic does ('ic <version>'). A download that answered 200 can be
# a captive portal's login page or an empty body; Windows refuses to start either, which lands in the catch.
function Test-IntenticIc([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $said = ''
    try { $said = (& $Path --version | Out-String).Trim() } catch { $said = '' }
    return ($said -like 'ic *')
}

# Get-IntenticChecksumRefusal: why the file at $Path is not the asset $Asset the release at $Base published, by the
# SHA256SUMS beside it (@{ Why; Fix }), or $null when it is. A sums file that does not list $Asset (a release from
# before its SHA256SUMS covered ic, 2026-10-16) vouches for nothing and is refused (2026-11-24). IC_SKIP_CHECKSUM=1
# installs ic unchecked from a server that publishes no SHA256SUMS or one that lists no ic; it never lets a mismatch
# through. The release also signs SHA256SUMS (minisign); that signature is the machine agent's to check, before it
# replaces ic or itself.
function Get-IntenticChecksumRefusal([string]$Path, [string]$Asset, [string]$Base) {
    $SumsHost = ([uri]$Base).Host
    $SumsFile = "$Path.SHA256SUMS"
    $Sums = @()
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $SumsFile -ErrorAction Stop
        $Sums = @(Get-Content -LiteralPath $SumsFile -ErrorAction Stop)
    } catch {
        $Sums = @()
    }
    Remove-Item -Force $SumsFile -ErrorAction SilentlyContinue
    if ($Sums.Count -eq 0) {
        if ($env:IC_SKIP_CHECKSUM -eq '1') {
            Write-IntenticWarn "$SumsHost served no SHA256SUMS, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
            return $null
        }
        return @{ Why = "$SumsHost served ic but not the SHA256SUMS to check it against."; Fix = 'run the same command again; IC_SKIP_CHECKSUM=1 installs ic unchecked from a server that publishes no SHA256SUMS.' }
    }
    $Want = ''
    foreach ($Line in $Sums) {
        if ($Line -match '^([0-9a-fA-F]{64}) [ *](?:\./)?(\S+)\s*$' -and $Matches[2] -eq $Asset) { $Want = $Matches[1].ToLowerInvariant() }
    }
    if (-not $Want) {
        if ($env:IC_SKIP_CHECKSUM -eq '1') {
            Write-IntenticWarn "the release's SHA256SUMS lists no $Asset, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
            return $null
        }
        return @{ Why = "the release's SHA256SUMS lists no $Asset, so the download cannot be checked."; Fix = 'run the same command again; if it says the same, report it: the release is missing a checksum. IC_SKIP_CHECKSUM=1 installs ic unchecked from a release older than its checksums.' }
    }
    # Get-FileHash is Windows PowerShell 4 and later; .NET's own SHA256 answers the same where it is missing.
    $Got = ''
    try {
        if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
            $Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLowerInvariant()
        } else {
            $Stream = [IO.File]::OpenRead($Path)
            try {
                $Got = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($Stream)) -replace '-', '').ToLowerInvariant()
            } finally {
                $Stream.Dispose()
            }
        }
    } catch {
        return @{ Why = "the download could not be read to check it ($($_.Exception.Message))."; Fix = 'run the same command again.' }
    }
    if ($Got -eq $Want) { return $null }
    return @{ Why = "the downloaded ic is not the one the release published (SHA-256 $Got, its SHA256SUMS says $Want), so it was deleted without being run."; Fix = "run the same command again; if it fails the same way, something between this device and $SumsHost is altering the download." }
}

function Get-IntenticIc {
    $Ic = $env:IC_BIN
    if ($Ic) { return $Ic }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IcDir = "$env:USERPROFILE\.intentic\ic\bin"
    New-Item -ItemType Directory -Force -Path $IcDir | Out-Null
    $IcDest = "$IcDir\ic.exe"
    $IcBase = if ($env:IC_URL) { $env:IC_URL } else { 'https://github.com/intentic/intentic/releases/latest/download' }
    # Never "exactly that release": the machine agent moves ic up by itself, so a desktop app left in the tray for days
    # put an older ic back on every Start, Stop or Restart it ran (2026-10-05). Compared as versions, major.minor.patch
    # first, a pre-release below its own release; an installed ic whose answer is not a version is replaced.
    $IcHave = ''
    if ($env:IC_VERSION -and (Test-Path $IcDest)) {
        try { $IcHave = (& $IcDest --version | Out-String).Trim() } catch { $IcHave = '' }
    }
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
        Write-IntenticSay "$IcHave is installed, and this run asks for ic $($env:IC_VERSION -replace '^v', '') or newer, so nothing is downloaded."
        $Ic = $IcDest
        Add-IntenticPath -Folder $IcDir -Command 'ic'
    } else {
        Write-IntenticStep 'fetching-ic' 'fetching the ic CLI...' 'Download ic'
        # THE ic THE DESKTOP APP CARRIES, copied instead of downloaded: a copy that answers exactly the pinned release is
        # the very binary the download would fetch, minus the network, so a device that cannot reach github.com still
        # gets its ic. Anything else leaves the download below to run, and that download is all the one-liner ever does.
        $IcCopied = $false
        if ($env:INTENTIC_IC_PATH -and $env:IC_VERSION -and (Test-Path -LiteralPath $env:INTENTIC_IC_PATH -PathType Leaf)) {
            $IcCarried = ''
            try { $IcCarried = (& $env:INTENTIC_IC_PATH --version | Out-String).Trim() } catch { $IcCarried = '' }
            if ($IcCarried -eq ('ic ' + ($env:IC_VERSION -replace '^v', ''))) {
                try {
                    Copy-Item -LiteralPath $env:INTENTIC_IC_PATH -Destination "$IcDest.tmp" -Force -ErrorAction Stop
                    Install-IntenticIcFile "$IcDest.tmp" $IcDest
                    $IcCopied = $true
                } catch {
                    Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
                }
            }
        }
        if ($IcCopied) {
            Write-IntenticSay "installed $IcCarried from the copy the desktop app carries."
            $Ic = $IcDest
            Add-IntenticPath -Folder $IcDir -Command 'ic'
        } else {
            # Windows PowerShell 5.1 redraws its progress bar for every chunk Invoke-WebRequest reads, which makes a
            # five-megabyte download take several seconds instead of a fraction of one.
            $ProgressPreference = 'SilentlyContinue'
            $IcFetched = $false
            # Why ic is not installed, by what failed (2026-11-20, intentic#49): $IcWhy once said "<host> did not answer"
            # whatever threw, and a device whose security software refused ic.exe was told to check a network that was
            # fine. 'network' keeps that wording with the failure's own words; 'refused' is a download that arrived and
            # was not installed (a checksum, a probe, a file Windows would not start); 'write' is a file Windows would not write.
            $IcFailed = 'network'
            $IcHost = ([uri]$IcBase).Host
            $IcWhy = "$IcHost did not answer from this device."
            $IcFix = 'check the network, then run the same command again.'
            # Named .exe so it can be started for the probe below; only a checked, probed download replaces the installed ic.
            $IcNew = "$IcDir\ic.download.exe"
            # The file being written when something throws: the download first, the installed ic once the swap starts.
            $IcWriting = $IcNew
            try {
                # By the .gz copy the release publishes beside ic (scripts-kit/gzip.ps1), else by ic itself: a release from
                # before the copies answers 404 for it, and so does a server that serves only ic (IC_URL).
                $IcPacked = $false
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe.gz" -OutFile "$IcNew.gz" -ErrorAction Stop
                    Expand-IntenticGzip -Source "$IcNew.gz" -Destination $IcNew
                    $IcPacked = $true
                } catch {
                    $IcPacked = $false
                } finally {
                    Remove-Item -Force "$IcNew.gz" -ErrorAction SilentlyContinue
                }
                if (-not $IcPacked) {
                    Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile $IcNew -ErrorAction Stop
                }
                $IcRefusal = Get-IntenticChecksumRefusal $IcNew 'ic-windows-amd64.exe' $IcBase
                if ($IcRefusal) {
                    $IcFailed = 'refused'
                    $IcWhy = $IcRefusal.Why
                    $IcFix = $IcRefusal.Fix
                } elseif (Test-IntenticIc $IcNew) {
                    $IcWriting = $IcDest
                    Install-IntenticIcFile $IcNew $IcDest
                    $IcFetched = $true
                } elseif (-not (Test-Path -LiteralPath $IcNew)) {
                    # Gone between landing and its probe: taken into quarantine, which no network check would explain.
                    $IcAdvice = Get-IntenticSecurityAdvice -Path $IcNew
                    $IcFailed = 'refused'
                    $IcWhy = "the downloaded ic was removed from $IcNew as soon as it arrived. $($IcAdvice.Suspect)"
                    $IcFix = $IcAdvice.Fix
                } else {
                    $IcWhy = 'what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture.'
                    # Test-IntenticIc reads every failure to start as "not ic"; one Windows refused is security software.
                    $IcStart = ''
                    try {
                        $null = & $IcNew --version
                    } catch {
                        if ((Test-IntenticAccessDenied $_.Exception) -or (Test-IntenticFileDenied $IcNew)) { $IcStart = Get-IntenticFailureLine $_ }
                    }
                    if (-not $IcStart -and (Test-IntenticFileDenied $IcNew)) { $IcStart = 'Access is denied' }
                    if ($IcStart) {
                        $IcAdvice = Get-IntenticSecurityAdvice -Path $IcNew
                        $IcFailed = 'refused'
                        $IcWhy = "Windows refused to start the downloaded ic at $IcNew ($IcStart). $($IcAdvice.Suspect)"
                        $IcFix = $IcAdvice.Fix
                    }
                }
            } catch {
                $IcFetched = $false
                $IcSaid = (Get-IntenticFailureLine $_).TrimEnd('.')
                if (Test-IntenticAccessDenied $_.Exception) {
                    $IcAdvice = Get-IntenticSecurityAdvice -Path $IcWriting
                    $IcFailed = 'write'
                    $IcWhy = "could not write $($IcWriting): $IcSaid. $($IcAdvice.Suspect)"
                    $IcFix = $IcAdvice.Fix
                } elseif ($IcWriting -eq $IcDest -or -not (Test-IntenticIcNetwork $_.Exception)) {
                    $IcFailed = 'write'
                    $IcWhy = "could not write $($IcWriting): $IcSaid."
                    $IcFix = "close anything running ic, check that $IcDir has room, then run the same command again."
                } else {
                    $IcWhy = "$IcHost did not answer from this device ($IcSaid)."
                }
            }
            Remove-Item -Force $IcNew -ErrorAction SilentlyContinue
            # The warning when an installed ic runs instead; <ic> is where it is.
            $IcKept = if ($IcFailed -ne 'network') { "the newest ic was not installed: $IcWhy The one installed at <ic> runs instead." } else { 'the newest ic could not be downloaded, so the one installed at <ic> runs instead.' }
            if ($IcFetched) {
                $Ic = $IcDest
                Add-IntenticPath -Folder $IcDir -Command 'ic'
            } elseif (Test-IntenticIc $IcDest) {
                Write-IntenticWarn $IcKept.Replace('<ic>', $IcDest)
                $Ic = $IcDest
            } elseif ($IcLeft = @(Get-IntenticIcLeftovers $IcDest | Where-Object { Test-IntenticIc $_ }) | Select-Object -First 1) {
                # The installed ic, moved aside by a swap Windows would not let finish (Install-IntenticIcFile).
                Write-IntenticWarn $IcKept.Replace('<ic>', $IcLeft)
                $Ic = $IcLeft
            } else {
                $IcInstalled = Get-Command ic -ErrorAction SilentlyContinue
                if ($IcInstalled -and (Test-IntenticIc $IcInstalled.Source)) {
                    Write-IntenticWarn $IcKept.Replace('<ic>', $IcInstalled.Source)
                    $Ic = $IcInstalled.Source
                } elseif ($IcFailed -eq 'refused') {
                    Stop-Intentic 'ic was downloaded but not installed, and no copy is installed.' $IcWhy $IcFix
                } elseif ($IcFailed -eq 'write') {
                    Stop-Intentic 'ic could not be installed, and no copy is installed.' $IcWhy $IcFix
                } else {
                    Stop-Intentic 'ic could not be downloaded, and no copy is installed.' $IcWhy $IcFix
                }
            }
        }
        Complete-IntenticStep
    }
    return $Ic
}
