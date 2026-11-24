# ---- bootstrap the agent binary (identical in device.ps1 and sync.ps1: generated from one source) ----
#
# Only when this device has no agent that can take the handover: one that can skips straight to `setup`,
# which asks the release channel itself and self-updates first. "Can" is asked by RUNNING the handover's own
# help, never by comparing versions - an agent that answers `version` can still be older than the words this
# script speaks to it, and then it is the `setup` that would have updated it that it cannot understand. That
# is what renaming the `computer` route to `device` did: every device paired before the rename answered the
# card's own command with "No command registered for `device`", with no route back to the self-update.
#
# The download is pinned to the tag `releases/latest` resolves to right now (one HEAD, no body, no API rate
# limit), so an interrupted transfer resumes against the exact release it started from, never a splice of
# two. What lands is checked against the release's SHA256SUMS before anything runs it, then probed by running it -
# `version` answering is the only proof the file is a working agent rather than 95 MB of captive-portal login page -
# and only a checked, probed binary is moved into place.

function Get-IntenticAgentVersion {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return '' }
    try {
        # Run it to completion, THEN take its first line. `& $Path version | Select-Object -First 1` reads
        # better and is wrong: Select-Object stops the pipeline early, which leaves $LASTEXITCODE unset, so
        # every probe of a perfectly good agent failed its own exit-code check and reported no version.
        $out = & $Path version
        if ($LASTEXITCODE -ne 0) { return '' }
        $said = "$($out | Select-Object -First 1)".Trim()
        if ($said -match '^\d+\.\d+\.\d+$') { return $said }
        return ''
    } catch {
        # Not a binary, not this architecture, or too truncated to start: all of them are "no version", which
        # is the answer this exists to give. Nothing is silenced with a redirection - on 5.1 that would turn a
        # native command's stderr into a terminating NativeCommandError under $ErrorActionPreference = 'Stop'.
        return ''
    }
}

# WHETHER THE INSTALLED AGENT UNDERSTANDS THE HANDOVER, asked by running its help rather than by reading its
# version: `<route> setup --help` prints a usage screen and exits 0 on an agent that has the route, exits
# non-zero on one that does not, and connects nothing either way. Every one of -Flags has to be on that screen
# too: an agent older than one of them refuses the whole handover over it ("No flag registered"). The
# embedding script passes the flags its handover uses that are newer than the route, and none otherwise.
#
# Assigned to a variable rather than redirected, and the assignment is doing two jobs: it keeps the usage screen
# off the user's screen, and it keeps the function's return value a plain boolean instead of the help text
# plus a boolean. Silencing the older agent's complaint instead would need a stderr redirection, which no
# .ps1 here may hold while $ErrorActionPreference = 'Stop' is in force - on Windows PowerShell 5.1 that pair
# turns a native command's diagnostics into a terminating error, on the very outcome a probe exists to
# detect (src-tauri/src/scripts.rs holds that line for every bundled script). So the one line such an agent
# writes stays visible, which is no loss: it is the truth, and the line after it says what is being done.
function Test-IntenticAgentSpeaks {
    param([string]$Path, [string]$Route, [string[]]$Flags = @())
    try {
        $help = & $Path $Route setup --help
        if ($LASTEXITCODE -ne 0) { return $false }
        $said = "$help"
        foreach ($flag in $Flags) {
            if (-not $said.Contains($flag)) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# What `releases/latest` currently points at, or '' when that cannot be established. A HEAD following the
# redirect: no body moves, and the answer is the tag itself.
function Get-IntenticPublishedVersion {
    try {
        $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create('https://github.com/intentic/intentic/releases/latest')
        $ask.Method = 'HEAD'
        $ask.UserAgent = 'intentic-installer'
        $ask.Timeout = 20000
        $answer = $ask.GetResponse()
        $landed = $answer.ResponseUri.AbsoluteUri
        $answer.Close()
        if ($landed -match '/tag/v(\d+\.\d+\.\d+)$') { return $Matches[1] }
        return ''
    } catch {
        return ''
    }
}

# ONE FILE, RESUMED RATHER THAN RESTARTED, with a percentage while it moves.
#
# Invoke-WebRequest is not what does this. Windows PowerShell 5.1's holds the entire body in memory before it
# writes a byte, its progress repaint is itself a measurable share of the transfer, and `-Resume` does not
# exist before PowerShell 6. HttpWebRequest with a Range header is the one shape both hosts have, and it
# streams to disk a megabyte at a time.
#
# A range the other end ignores is the hazard worth naming: the answer is then the WHOLE file with a 200, and
# appending that to a partial produces a corrupt binary that no retry would ever fix. So the status is checked
# rather than assumed, and anything but 206 starts the file again from zero.
#
# Returns $true when the other end says the partial already holds every byte (416 to a resumed request: a run that
# finished the download and stopped before the swap), and $false after a transfer.
function Copy-IntenticFile {
    param([string]$Uri, [string]$Path)
    $have = 0
    if (Test-Path $Path) { $have = (Get-Item $Path).Length }
    $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
    $ask.UserAgent = 'intentic-installer'
    $ask.Timeout = 30000
    $ask.ReadWriteTimeout = 120000
    if ($have -gt 0) { $ask.AddRange($have) }
    try {
        $answer = $ask.GetResponse()
    } catch {
        # A .NET method's failure arrives wrapped (MethodInvocationException), so the WebException is looked for.
        $failure = $_.Exception
        while ($null -ne $failure -and -not ($failure -is [System.Net.WebException])) { $failure = $failure.InnerException }
        $refused = $null
        if ($null -ne $failure) { $refused = $failure.Response }
        if ($have -gt 0 -and $null -ne $refused -and [int]$refused.StatusCode -eq 416) {
            $refused.Close()
            return $true
        }
        throw
    }
    if ($have -gt 0 -and $answer.StatusCode -ne [System.Net.HttpStatusCode]::PartialContent) {
        $answer.Close()
        Remove-Item -Force -ErrorAction SilentlyContinue $Path
        $have = 0
        $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
        $ask.UserAgent = 'intentic-installer'
        $ask.Timeout = 30000
        $ask.ReadWriteTimeout = 120000
        $answer = $ask.GetResponse()
    }
    $total = $answer.ContentLength + $have
    # A repainting line where somebody is watching, one line per 10 percent where this is a pipe into the
    # desktop app's log - a carriage return in a log file is a line nobody can read.
    $live = -not [Console]::IsOutputRedirected
    $source = $null
    $file = $null
    $done = $have
    $shown = -1
    try {
        $source = $answer.GetResponseStream()
        $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = New-Object byte[] 1048576
        while ($true) {
            $read = $source.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { break }
            $file.Write($buffer, 0, $read)
            $done += $read
            if ($total -gt 0) {
                # Every percent where a line can be repainted; every tenth where each one is a line of its own
                # in somebody's log. Both land on 100 exactly, because a progress readout that stops at 99 is
                # the one thing people read as "stuck".
                $percent = [int](100 * $done / $total)
                $mark = if ($live) { $percent } else { 10 * [int][math]::Floor($percent / 10) }
                if ($mark -gt $shown) {
                    $shown = $mark
                    $line = '  {0,3}% of {1} MB' -f $mark, [int]($total / 1MB)
                    if ($live) { Write-Host "`r$line" -NoNewline } else { Write-Host $line }
                }
            }
        }
    } finally {
        if ($null -ne $file) { $file.Close() }
        if ($null -ne $source) { $source.Close() }
        $answer.Close()
        if ($live -and $shown -ge 0) { Write-Host '' }
    }
    return $false
}

# By the .gz copy the release publishes beside the binary, resumed like the binary and unpacked once whole
# (scripts-kit/gzip.ps1): $true when $Part is the unpacked agent. $false sends the caller to the binary itself, which
# is what a release from before the copies has (its .gz answers 404), what a copy that does not unpack falls back to,
# and what a partial of the binary already here resumes.
function Get-IntenticPackedAgent {
    param([string]$Url, [string]$Part, [string]$Dest, [string]$Version)
    if (Test-Path $Part) { return $false }
    $packed = "$Part.gz"
    $failure = $null
    Suspend-IntenticLine
    try {
        $null = Copy-IntenticFile -Uri "$Url.gz" -Path $packed
    } catch {
        Resume-IntenticLine
        if (Test-IntenticMissing $_.Exception) {
            Remove-Item -Force -ErrorAction SilentlyContinue $packed
            return $false
        }
        $failure = $_.Exception
    }
    if ($failure) {
        # Windows refusing the partial file is security software, not the network (2026-11-20, intentic#49).
        if (Test-IntenticAccessDenied $failure) { Stop-IntenticAgentRefused -Dest $Dest -Part '' -Version $Version -How 'denied' -Blocked $packed }
        Stop-Intentic 'intentic-machine could not be downloaded.' "the download stopped before it finished ($($failure.Message)); what arrived is kept, and running the same command again resumes it." 'check the network, then run the same command again.'
    }
    Resume-IntenticLine
    $unpacked = $true
    try {
        Expand-IntenticGzip -Source $packed -Destination $Part
    } catch {
        $unpacked = $false
        Remove-Item -Force -ErrorAction SilentlyContinue $Part
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $packed
    }
    return $unpacked
}

# WHEN SECURITY SOFTWARE STANDS BETWEEN THE AGENT AND ITS PLACE (2026-11-12). On a PC whose antivirus will not have
# intentic-machine.exe (the first was Bitdefender Endpoint Security Tools, run from a company's console), the download
# arrived and even answered its probe, and then Windows refused the one name: "Access to the path is denied", for an
# empty file as much as for the agent, while any other file saved in the same folder. That read as a permissions fault,
# and nothing anyone does on the PC itself changes it: whoever manages the antivirus has to allow the file. So the
# refusal is told apart and named, with what to ask them for. Nothing here adds an exclusion: software that exempts
# itself from a scanner is what malware does, and scanners treat it so. Get-IntenticSecurityProduct and
# Test-IntenticAccessDenied are kit.ps1's, since the ic download and the unexpected stop need them too (2026-11-20).

# How security software refused the agent, or '' when the refusal looks like anything else: 'removed' when the probed
# download is gone (taken into quarantine after it ran), 'name' when this folder takes a file under any other name and
# refuses one under the agent's own, even an empty one. Cmdlets rather than [IO.File], so a test can stand in for them.
# The third way, 'denied', is not found here but told by the failure itself (Test-IntenticAccessDenied): a file Windows
# lists and will not open, start or move, which is how the agent already in place was taken (2026-11-20, intentic#49).
function Get-IntenticAgentRefusal {
    param([string]$Dest, [string]$Part)
    if (-not (Test-Path -LiteralPath $Part)) { return 'removed' }
    if (Test-Path -LiteralPath $Dest) { return '' }
    $other = Join-Path (Split-Path $Dest) ('intentic-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        New-Item -ItemType File -Path $other -ErrorAction Stop | Out-Null
    } catch {
        # The folder takes nothing at all: its permissions, or a full disk, not a name.
        return ''
    }
    Remove-Item -Force -LiteralPath $other -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType File -Path $Dest -ErrorAction Stop | Out-Null
    } catch {
        return 'name'
    }
    Remove-Item -Force -LiteralPath $Dest -ErrorAction SilentlyContinue
    return ''
}

# The note to hand whoever manages the antivirus, within the 600 characters the desktop app's card carries: its last
# lines go first when a long path or product name would take it over.
function Get-IntenticAllowNote {
    param([string]$Who, [string]$Leaf, [string]$Folder, [string]$Version, [string]$Hash, [string]$How)
    $blocks = if ($How -eq 'removed') {
        "removes $Leaf as soon as it is downloaded."
    } elseif ($How -eq 'denied') {
        "blocks $Leaf (Windows answers ""Access denied"" when it is opened, started or replaced)."
    } else {
        "blocks $Leaf (Windows answers ""Access denied"", even for an empty file of that name)."
    }
    $lines = @(
        "Please allow Intentic on this PC: $Who $blocks",
        "- Restore $Leaf from quarantine, if it is there.",
        "- Allow the folder $Folder. The program updates itself, so allow it by folder, not by hash."
    )
    $file = 'File: intentic-machine'
    if ($Version) { $file += " $Version" }
    if ($Hash) { $file += ", SHA-256 $Hash" }
    $lines += $file
    if ($Version) { $lines += "Source: https://github.com/intentic/intentic/releases/tag/v$Version" }
    $count = $lines.Count
    while ($count -gt 1 -and ($lines[0..($count - 1)] -join "`n").Length -gt 600) { $count-- }
    return ($lines[0..($count - 1)] -join "`n")
}

# The stop for an agent security software will not let in. The desktop app reads the requirement line (plain mode
# only, where it is the reader) as something only the reader, or whoever manages their antivirus, can do; a terminal
# gets the same words in the stop block, and the note under it. Its JSON is kept ASCII (\u escapes), since a redirected
# Windows PowerShell writes in the console's code page and a path may hold any letter.
# -Blocked is the file Windows refused for 'denied', when that is not $Dest itself (the partial download).
function Stop-IntenticAgentRefused {
    param([string]$Dest, [string]$Part, [string]$Version, [string]$How, [string]$Blocked = '')
    $product = Get-IntenticSecurityProduct
    $who = if ($product) { $product } else { 'Security software on this PC' }
    $manager = if ($product) { $product } else { 'the security software' }
    $leaf = Split-Path $Dest -Leaf
    $folder = Split-Path $Dest
    $hash = ''
    if ($Part -and (Test-Path -LiteralPath $Part)) {
        try { $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Part).Hash.ToLowerInvariant() } catch { $hash = '' }
    }
    $title = "$who is blocking $leaf"
    $what = 'the program Intentic needs on this PC to sync folders and reach your sandboxes'
    if (-not $Blocked) { $Blocked = $Dest }
    $problem = if ($How -eq 'removed') {
        "$leaf, $what, was removed as soon as it was downloaded."
    } elseif ($How -eq 'denied') {
        "Windows answered ""Access is denied"" for $Blocked, $what, though it is there."
    } else {
        "Windows refused to save $leaf, $what, at $Dest, though other files save in that folder."
    }
    $remedy = "Ask whoever manages $manager on this PC (at work, your IT) to restore $leaf from its quarantine and allow the folder $folder, then try again."
    $note = Get-IntenticAllowNote -Who $who -Leaf $leaf -Folder $folder -Version $Version -Hash $hash -How $How
    if ($IntenticKit.Mode -eq 'plain') {
        $row = [ordered]@{
            id = 'security-software'; title = $title; problem = $problem; remedy = $remedy; action = 'user'; detail = $note
            product = $product; path = $Dest; folder = $folder; version = $Version; sha256 = $hash
        }
        $json = [regex]::Replace(($row | ConvertTo-Json -Compress), '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
        Write-Host "intentic-requirement: $json"
    } else {
        Write-IntenticSay "For whoever manages $manager`:"
        foreach ($line in ($note -split "`n")) { Write-IntenticSay "  $line" }
    }
    Stop-Intentic "$title." $problem $remedy
}

# THE RELEASE'S OWN SHA-256 FOR THE AGENT, read from the SHA256SUMS beside it before the download starts (2026-11-24).
# The download is checked against it before anything runs it, and every way the check cannot be made stops the install:
# a binary this script runs next is never taken on trust. The release also signs SHA256SUMS (SHA256SUMS.sig, minisign);
# Windows has no minisign, so the sums come from the same https origin as the binary and the signature is left to the
# agent, which checks it before it replaces itself.
function Get-IntenticAgentSum {
    param([string]$Sums, [string]$Asset)
    $text = ''
    try {
        $ask = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Sums)
        $ask.UserAgent = 'intentic-installer'
        $ask.Timeout = 30000
        $answer = $ask.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($answer.GetResponseStream())
            $text = $reader.ReadToEnd()
            $reader.Close()
        } finally {
            $answer.Close()
        }
    } catch {
        Stop-Intentic 'intentic-machine could not be installed.' "the release's SHA256SUMS did not download ($($_.Exception.Message)), so intentic-machine cannot be checked against it." 'check the network, then run the same command again.'
    }
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^([0-9a-fA-F]{64}) [ *](?:\./)?(\S+)\s*$' -and $Matches[2] -eq $Asset) { return $Matches[1].ToLowerInvariant() }
    }
    Stop-Intentic 'intentic-machine could not be installed.' "the release's SHA256SUMS lists no $Asset, so the download cannot be checked." 'run the same command again; if it says the same, report it: the release is missing a checksum.'
}

# The file's SHA-256 in lowercase hex, or '' when it cannot be read. Get-FileHash is Windows PowerShell 4 and later;
# .NET's own SHA256 answers the same where it is missing.
function Get-IntenticFileSha256 {
    param([string]$Path)
    try {
        if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
            return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLowerInvariant()
        }
        $stream = [IO.File]::OpenRead($Path)
        try {
            return ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } catch {
        return ''
    }
}

# Put a first agent at $Dest. Everything past this - keeping it current, PATH, the launcher stub - is the
# agent's own `setup`.
function Install-IntenticAgent {
    param([string]$Dest, [string]$Arch)
    $releases = 'https://github.com/intentic/intentic/releases'
    New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
    # Windows PowerShell 5.1 negotiates whatever its .NET default is, and GitHub has required TLS 1.2 for
    # years: without this line the download fails on exactly the machines least able to explain why.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $published = Get-IntenticPublishedVersion
    # THE STAGED NAME ENDS IN .exe, AND THAT SUFFIX IS LOAD-BEARING. What lands is probed by running it, and
    # PowerShell resolves a command by EXTENSION: a path whose extension is not in PATHEXT is not a program to
    # it, whatever the bytes say. So `& $part version` on `intentic-machine.exe.part-1.248.0` fails with "not
    # recognized as the name of a cmdlet, function, script file, or operable program", the probe reads that as
    # "no version", and this function deletes a complete 83 MB download and blames a captive portal - which is
    # exactly what it did to the first machine that ever reached this path with an agent already installed.
    #
    # The agent's own `upgrade` stages without the suffix and is fine: it probes with spawn, and CreateProcess
    # loads a PE by its bytes. This block is the one that has to ask a shell.
    $asset = "intentic-machine-windows-$Arch.exe"
    if ($published) {
        $url = "$releases/download/v$published/$asset"
        $sums = "$releases/download/v$published/SHA256SUMS"
        $part = "$Dest.part-$published.exe"
    } else {
        $url = "$releases/latest/download/$asset"
        $sums = "$releases/latest/download/SHA256SUMS"
        $part = "$Dest.part.exe"
    }
    $want = Get-IntenticAgentSum -Sums $sums -Asset $asset
    # A partial from another release is bytes that can never be finished.
    $leaf = Split-Path $Dest -Leaf
    Get-ChildItem -Path (Split-Path $Dest) -Filter "$leaf.part*" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne $part -and $_.FullName -ne "$part.gz" } |
        ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
    $named = if ($published) { " $published" } else { '' }
    Write-IntenticStep '' "downloading intentic-machine$named..." "Download intentic-machine$named"
    $attempt = 0
    $packedAgent = Get-IntenticPackedAgent -Url $url -Part $part -Dest $Dest -Version $published
    while (-not $packedAgent) {
        $attempt++
        # Copy-IntenticFile draws its own percentage, so the live line steps aside while it runs.
        Suspend-IntenticLine
        $fetched = $true
        $whole = $false
        $why = ''
        $denied = $false
        try {
            $whole = Copy-IntenticFile -Uri $url -Path $part
        } catch {
            $fetched = $false
            $why = $_.Exception.Message
            $denied = Test-IntenticAccessDenied $_.Exception
        }
        Resume-IntenticLine
        if ($denied) { Stop-IntenticAgentRefused -Dest $Dest -Part '' -Version $published -How 'denied' -Blocked $part }
        if (-not $fetched) {
            Stop-Intentic 'intentic-machine could not be downloaded.' "the download stopped before it finished ($why); what arrived is kept, and running the same command again resumes it." 'check the network, then run the same command again.'
        }
        # A partial the other end calls finished is used when its checksum passes. One that does not is bytes no resume
        # can mend (the 416 would come back on every run), so it is dropped and fetched again, once.
        if ($whole -and $attempt -eq 1 -and (Get-IntenticFileSha256 -Path $part) -ne $want) {
            Remove-Item -Force -ErrorAction SilentlyContinue $part
            continue
        }
        break
    }
    # Checked before it is first run (the probe below runs it). A file that fails is deleted, so the next run downloads
    # it whole instead of resuming bytes that can never match.
    $got = Get-IntenticFileSha256 -Path $part
    if ($got -ne $want) {
        if (-not (Test-Path -LiteralPath $part)) { Stop-IntenticAgentRefused -Dest $Dest -Part $part -Version $published -How 'removed' }
        $why = if ($got) {
            "the downloaded intentic-machine is not the one the release published (SHA-256 $got, its SHA256SUMS says $want), so it was deleted without being run."
        } else {
            "the download could not be read to check it against the release's SHA256SUMS, so it was deleted without being run."
        }
        Remove-Item -Force -ErrorAction SilentlyContinue $part
        Stop-Intentic 'intentic-machine could not be installed.' $why 'run the same command again; if it fails the same way, something between this PC and github.com is altering the download.'
    }
    if (-not (Get-IntenticAgentVersion -Path $part)) {
        # Gone between landing and its probe: taken into quarantine, which no network check would ever explain.
        if (-not (Test-Path -LiteralPath $part)) { Stop-IntenticAgentRefused -Dest $Dest -Part $part -Version $published -How 'removed' }
        Remove-Item -Force -ErrorAction SilentlyContinue $part
        Stop-Intentic 'intentic-machine could not be installed.' 'what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture.' 'check the network, then run the same command again.'
    }
    # Swap, do not overwrite: Windows refuses to overwrite or delete a RUNNING executable - but it does allow
    # RENAMING one out of the way, which leaves the live process running from the renamed file while the new
    # binary takes its place. The leftover is cleared on the next run, once nothing is executing it.
    Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
    $refused = ''
    $denied = $false
    try {
        if (Test-Path $Dest) { Move-Item -Force -Path $Dest -Destination "$Dest.old" -ErrorAction Stop }
        Move-Item -Force -Path $part -Destination $Dest -ErrorAction Stop
    } catch {
        $refused = $_.Exception.Message
        $denied = Test-IntenticAccessDenied $_.Exception
    }
    if ($refused) {
        # The agent moved aside goes back where it was, where it still can: a PC that had one keeps it.
        if (-not (Test-Path -LiteralPath $Dest) -and (Test-Path -LiteralPath "$Dest.old")) {
            Move-Item -Force -Path "$Dest.old" -Destination $Dest -ErrorAction SilentlyContinue
        }
        $how = Get-IntenticAgentRefusal -Dest $Dest -Part $part
        if (-not $how -and $denied) { $how = 'denied' }
        if ($how) { Stop-IntenticAgentRefused -Dest $Dest -Part $part -Version $published -How $how }
        Stop-Intentic 'intentic-machine could not be put in place.' "Windows refused to move it to $Dest ($refused)." 'close anything using that folder and run the same command again; if it repeats, check whether security software on this PC blocked intentic-machine.exe.'
    }
    # Started once more under its own name, before the run spends its code on a handover it cannot make: the partial
    # answered its probe, and security software that keys on the name takes the file only now (2026-11-20, intentic#49).
    if (Test-IntenticAgentDenied -Path $Dest) { Stop-IntenticAgentRefused -Dest $Dest -Part '' -Version $published -How 'denied' }
    Complete-IntenticStep
}

# Whether Windows refuses to start the program at $Path with "Access is denied". Every other outcome, a version or none,
# is $false: telling a working agent from a broken one is Get-IntenticAgentVersion's question, not this one's.
function Test-IntenticAgentDenied {
    param([string]$Path)
    if (Test-IntenticFileDenied $Path) { return $true }
    try {
        $null = & $Path version
    } catch {
        return (Test-IntenticAccessDenied $_.Exception)
    }
    return $false
}
# The agent to hand over to: AGENT_BIN as it is (a dev build, taken without asking), else the installed agent when it
# speaks the route and every flag in -Flags, else a fresh download. Returns the path, or '' for AGENT_BIN.
function Get-IntenticAgent {
    param([string]$Route, [string[]]$Flags = @())
    if ($env:AGENT_BIN) { return '' }
    # The only Windows agent a release publishes is x64, which Windows on ARM runs under emulation.
    $dest = Join-Path $HOME '.intentic\machine\bin\intentic-machine.exe'
    $have = Get-IntenticAgentVersion -Path $dest
    if ($have -and -not (Test-IntenticAgentSpeaks -Path $dest -Route $Route -Flags $Flags)) {
        Write-IntenticSay "intentic-machine $have on this device cannot take this handover, so a newer one replaces it."
        $have = ''
    }
    if (-not $have) { Install-IntenticAgent -Dest $dest -Arch 'amd64' }
    return $dest
}

# Run the agent with the handover's arguments and keep its exit code. AGENT_BIN is a whitespace-separated command: its
# first token is the program, the rest lead the arguments. Named, then splatted: `@(...)` is the array subexpression
# operator and would pass the whole list as one space-joined string. Only `@name` splats.
#
# THE START ITSELF CAN BE REFUSED, and was the one call on this path nothing guarded: on a PC whose security software
# took intentic-machine.exe after its probes had passed, `& $Bin` threw "Access is denied" and the run ended in the
# kit's unexpected stop, saying only that, with no path and no step (2026-11-20, intentic#49). The try holds the start
# alone: a native command's own exit code and output pass through it untouched.
function Invoke-IntenticAgent {
    param([string]$Bin, [string[]]$Arguments)
    Suspend-IntenticLine
    $failure = $null
    $said = ''
    try {
        if ($env:AGENT_BIN) {
            $parts = $env:AGENT_BIN -split '\s+'
            $lead = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] } else { @() }
            $agentArgs = @($lead) + $Arguments
            & $parts[0] @agentArgs
        } else {
            & $Bin @Arguments
        }
    } catch {
        $failure = $_.Exception
        $said = Get-IntenticFailureLine $_
    }
    if ($failure) {
        if ($Bin -and ((Test-IntenticAccessDenied $failure) -or (Test-IntenticFileDenied $Bin))) { Stop-IntenticAgentRefused -Dest $Bin -Part '' -Version '' -How 'denied' }
        $what = if ($Bin) { $Bin } else { $env:AGENT_BIN }
        Stop-Intentic 'intentic-machine could not be started.' "Windows could not start $what ($said)." 'get a new command from the card it came from, and run it.'
    }
    Set-IntenticExit $LASTEXITCODE
}
# ---- end of the agent binary bootstrap ----
