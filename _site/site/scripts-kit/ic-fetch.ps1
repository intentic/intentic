# Get-IntenticIc: the ic CLI to run, found or downloaded. IC_BIN overrides (a checkout's own build). Downloaded on
# every run that pins no release, so re-running a one-liner upgrades a device; a run pinned to a release (IC_VERSION)
# that finds it or a newer one installed skips it, and only a failed download falls back to an installed ic. Download-
# then-rename: overwriting a running executable fails, and a half-downloaded binary must never be what runs. A pinned
# run the desktop app started copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is exactly the
# release asked for. A download is checked against the release's SHA256SUMS before anything runs it; a mismatch is
# deleted unrun and the ic already installed stays.
# Test-IntenticIc: the file starts and answers --version as ic does ('ic <version>'). A download that answered 200 can be
# a captive portal's login page or an empty body; Windows refuses to start either, which lands in the catch.
function Test-IntenticIc([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $said = ''
    try { $said = (& $Path --version | Out-String).Trim() } catch { $said = '' }
    return ($said -like 'ic *')
}

# Get-IntenticChecksumRefusal: why the file at $Path is not the asset $Asset the release at $Base published, by the
# SHA256SUMS beside it (@{ Why; Fix }), or $null when it is. A release from before its SHA256SUMS covered ic lists no
# ic-* asset at all, and has nothing to check against. IC_SKIP_CHECKSUM=1 installs ic unchecked from a server that
# publishes no SHA256SUMS; it never lets a mismatch through. The release also signs SHA256SUMS (minisign); that
# signature is the machine agent's to check, before it replaces ic or itself.
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
    $Listed = $false
    foreach ($Line in $Sums) {
        if ($Line -match '^([0-9a-fA-F]{64}) [ *](?:\./)?(\S+)\s*$') {
            if ($Matches[2] -eq $Asset) { $Want = $Matches[1].ToLowerInvariant() }
            if ($Matches[2] -like 'ic-*') { $Listed = $true }
        }
    }
    if (-not $Want) {
        if (-not $Listed) {
            Write-IntenticSay "this release's SHA256SUMS predates checksums for ic, so the download is not checked."
            return $null
        }
        return @{ Why = "the release's SHA256SUMS lists no $Asset, so the download cannot be checked."; Fix = 'run the same command again; if it says the same, report it: the release is missing a checksum.' }
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
                    Move-Item -Force "$IcDest.tmp" $IcDest -ErrorAction Stop
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
            $IcRefused = $false
            $IcWhy = "$(([uri]$IcBase).Host) did not answer from this device."
            $IcFix = 'check the network, then run the same command again.'
            # Named .exe so it can be started for the probe below; only a checked, probed download replaces the installed ic.
            $IcNew = "$IcDir\ic.download.exe"
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
                    $IcRefused = $true
                    $IcWhy = $IcRefusal.Why
                    $IcFix = $IcRefusal.Fix
                } elseif (Test-IntenticIc $IcNew) {
                    Move-Item -Force $IcNew $IcDest -ErrorAction Stop
                    $IcFetched = $true
                } else {
                    $IcWhy = 'what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture.'
                }
            } catch {
                $IcFetched = $false
            }
            Remove-Item -Force $IcNew -ErrorAction SilentlyContinue
            # The warning when an installed ic runs instead; <ic> is where it is.
            $IcKept = if ($IcRefused) { "the newest ic was not installed: $IcWhy The one installed at <ic> runs instead." } else { 'the newest ic could not be downloaded, so the one installed at <ic> runs instead.' }
            if ($IcFetched) {
                $Ic = $IcDest
                Add-IntenticPath -Folder $IcDir -Command 'ic'
            } elseif (Test-IntenticIc $IcDest) {
                Write-IntenticWarn $IcKept.Replace('<ic>', $IcDest)
                $Ic = $IcDest
            } else {
                $IcInstalled = Get-Command ic -ErrorAction SilentlyContinue
                if ($IcInstalled -and (Test-IntenticIc $IcInstalled.Source)) {
                    Write-IntenticWarn $IcKept.Replace('<ic>', $IcInstalled.Source)
                    $Ic = $IcInstalled.Source
                } elseif ($IcRefused) {
                    Stop-Intentic 'ic was downloaded but not installed, and no copy is installed.' $IcWhy $IcFix
                } else {
                    Stop-Intentic 'ic could not be downloaded, and no copy is installed.' $IcWhy $IcFix
                }
            }
        }
        Complete-IntenticStep
    }
    return $Ic
}
