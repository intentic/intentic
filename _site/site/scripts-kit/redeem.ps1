# Assert-IntenticCode <host> <code>: the command's own shape, checked before anything is downloaded, so a mangled one
# fails in a second. The code itself is spent later (below), after the steps that need none of what it stands for.
function Assert-IntenticCode {
    param([string]$Server, [string]$Code)
    if ($Server -notmatch '^[A-Za-z0-9.-]+$') { Stop-Intentic 'This command is not complete.' "$Server is not the address of a sandbox." 'get a new command from the card it came from.' }
    if ($Code -notmatch '^[A-Za-z0-9-]+$') { Stop-Intentic 'This code is not valid any more.' '' 'get a new command from the card it came from.' }
}

# Invoke-IntenticRedeem <host> <code> <kind> [name]: spend a single-use code at the sandbox that minted it. A spent code
# cannot be spent again, so a script redeems it AFTER the steps that need none of what it stands for (a download, a
# question, a token check): one of those failing leaves the code valid, and "run the same command again" stays true. The
# answer is `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), returned as a hashtable of the keys a run
# started from the environment reads: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER, CONNECT_TOKEN, ZONE, HOST_NAME,
# HOST_ID. Only those keys are taken, and they never pass through $env:, so no token outlives the run in the person's
# shell. -Name is the name a server will take if its code was minted without one, for the sandbox to answer that name's
# HOST_ID (the id its tunnel and container are named for); only a settled name (a-z, 0-9, _) is sent.
#
# Invoke-WebRequest -UseBasicParsing works on 5.1 and 7 alike. A 404 or 429 throws on both, with the body read back
# from the exception's response: 5.1 hands a WebResponse whose stream is still readable, 7 an HttpResponseMessage and
# the body in ErrorDetails.
function Invoke-IntenticRedeem {
    param([string]$Server, [string]$Code, [string]$Kind, [string]$Name)
    Assert-IntenticCode -Server $Server -Code $Code
    Write-IntenticStep '' "checking the code with $Server..." "Check the code for $Server"
    $query = ''
    if ($Name -cmatch '^[a-z0-9_]+$') { $query = "?name=$Name" }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $status = 0
    $body = ''
    try {
        $reply = Invoke-WebRequest -Method Post -UseBasicParsing -TimeoutSec 30 -Uri "https://$Server/system/redeem/$Code$query" -ErrorAction Stop
        $status = [int]$reply.StatusCode
        $body = if ($reply.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($reply.Content) } else { [string]$reply.Content }
    } catch {
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try { $status = [int]$response.StatusCode } catch { $status = 0 }
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $body = $_.ErrorDetails.Message
            } else {
                try {
                    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
                    $body = $reader.ReadToEnd()
                    $reader.Close()
                } catch { $body = '' }
            }
        }
    }
    if ($status -eq 404 -or $status -eq 429) {
        # The sandbox answers one sentence, "<what happened>: <what to do>". Anything else (a proxy's or a CDN's HTML
        # page, several lines, a wall of text) is not something to print as a headline.
        $said = "$body".Trim()
        if ($said -match '[<\r\n]' -or $said.Length -gt 200) { $said = '' }
        $at = $said.IndexOf(': ')
        if ($at -gt 0) { Stop-Intentic ($said.Substring(0, $at) + '.') '' $said.Substring($at + 2) }
        if ($said) { Stop-Intentic $said '' 'get a new command from the card it came from.' }
        if ($status -eq 429) { Stop-Intentic 'The code could not be checked.' "$Server has had too many tries from this device in the last minute." 'wait a minute, then run the same command again.' }
        Stop-Intentic 'This code is not valid any more.' '' 'get a new command from the card it came from.'
    }
    if ($status -eq 0) { Stop-Intentic 'The code could not be checked.' "$Server did not answer from this device." 'check the network, then run the same command again.' }
    if ($status -ne 200) { Stop-Intentic 'The code could not be checked.' "$Server answered with HTTP $status." 'run the same command again in a minute.' }
    $taken = @{}
    $kept = @('KIND', 'SANDBOX_URL', 'PAIR_TOKEN', 'SYNC_DIR', 'TAKEOVER', 'CONNECT_TOKEN', 'ZONE', 'HOST_NAME', 'HOST_ID')
    foreach ($line in ($body -split "`r?`n")) {
        $at = $line.IndexOf('=')
        if ($at -gt 0 -and $kept -contains $line.Substring(0, $at)) { $taken[$line.Substring(0, $at)] = $line.Substring($at + 1) }
    }
    if ($taken['KIND'] -ne $Kind) {
        $other = if ($taken['KIND']) { $taken['KIND'] } else { 'different thing' }
        Stop-Intentic 'This code belongs to another command.' "it connects a $other, and this command connects a $Kind." 'get a new command from the card it came from.'
    }
    Complete-IntenticStep
    return $taken
}
