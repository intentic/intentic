# Get-IntenticIc: the ic CLI to run, found or downloaded. IC_BIN overrides (a checkout's own build). Downloaded on
# every run that pins no release, so re-running a one-liner upgrades a device; a run pinned to a release (IC_VERSION)
# that finds it or a newer one installed skips it, and only a failed download falls back to an installed ic. Download-
# then-rename: overwriting a running executable fails, and a half-downloaded binary must never be what runs. A pinned
# run the desktop app started copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is exactly the
# release asked for.
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
            try {
                Invoke-WebRequest -UseBasicParsing -Uri "$IcBase/ic-windows-amd64.exe" -OutFile "$IcDest.tmp" -ErrorAction Stop
                Move-Item -Force "$IcDest.tmp" $IcDest -ErrorAction Stop
                $IcFetched = $true
            } catch {
                Remove-Item -Force "$IcDest.tmp" -ErrorAction SilentlyContinue
            }
            if ($IcFetched) {
                $Ic = $IcDest
                Add-IntenticPath -Folder $IcDir -Command 'ic'
            } elseif (Test-Path $IcDest) {
                Write-IntenticWarn "the newest ic could not be downloaded, so the one installed at $IcDest runs instead."
                $Ic = $IcDest
            } else {
                $IcInstalled = Get-Command ic -ErrorAction SilentlyContinue
                if ($IcInstalled) {
                    Write-IntenticWarn "the newest ic could not be downloaded, so the one installed at $($IcInstalled.Source) runs instead."
                    $Ic = $IcInstalled.Source
                } else {
                    Stop-Intentic 'ic could not be downloaded, and no copy is installed.' "$(([uri]$IcBase).Host) did not answer from this device." 'check the network, then run the same command again.'
                }
            }
        }
        Complete-IntenticStep
    }
    return $Ic
}
