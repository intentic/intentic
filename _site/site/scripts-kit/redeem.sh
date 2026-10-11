# kit_redeem_check <host> <code>: the command's own shape, checked before anything is downloaded, so a mangled one fails
# in a second. The code itself is spent later (below), after the steps that need none of what it stands for.
kit_redeem_check() {
    case "$1" in
        "" | *[!A-Za-z0-9.-]*) kit_stop "This command is not complete." "$1 is not the address of a sandbox." "get a new command from the card it came from." ;;
    esac
    case "$2" in
        "" | *[!A-Za-z0-9-]*) kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
    esac
}

# kit_redeem <host> <code> <kind> [name]: spend a single-use code at the sandbox that minted it. A spent code cannot be
# spent again, so a script redeems it AFTER the steps that need none of what it stands for (a download, a question, a
# token check): one of those failing leaves the code valid, and "run the same command again" stays true. The answer is
# `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), read into the very variables a run started from the
# environment uses: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER, CONNECT_TOKEN, ZONE, HOST_NAME, HOST_ID. Only those
# keys are taken, and nothing is evaluated. [name] is the name a server will take if its code was minted without one,
# for the sandbox to answer that name's HOST_ID (the id its tunnel is named for); only a settled name (a-z, 0-9, _) is
# sent.
kit_redeem() {
    kit_redeem_check "$1" "$2"
    kit_step "" "checking the code with $1…" "Check the code for $1"
    kit_query=""
    case "${4:-}" in
        "" | *[!a-z0-9_]*) ;;
        *) kit_query="?name=$4" ;;
    esac
    kit_reply="$(curl -s -X POST --max-time 30 -w '\n%{http_code}' "https://$1/system/redeem/$2$kit_query" 2>/dev/null || true)"
    kit_status="$(printf '%s\n' "$kit_reply" | tail -n 1)"
    # Carriage returns off: a CRLF answer would leave one on every value, and KIND would never match.
    kit_body="$(printf '%s\n' "$kit_reply" | sed '$d' | tr -d '\r')"
    case "$kit_status" in
        200) ;;
        404 | 429)
            # The sandbox answers one sentence, "<what happened>: <what to do>". Anything else (a proxy's or a CDN's HTML
            # page, several lines, a wall of text) is not something to print as a headline.
            kit_said="$kit_body"
            kit_nl='
'
            case "$kit_said" in
                *"<"* | *"$kit_nl"*) kit_said="" ;;
            esac
            [ "${#kit_said}" -le 200 ] || kit_said=""
            case "$kit_said" in
                *": "*) kit_stop "${kit_said%%: *}." "" "${kit_said#*: }" ;;
                "") ;;
                *) kit_stop "$kit_said" "" "get a new command from the card it came from." ;;
            esac
            if [ "$kit_status" = 429 ]; then
                kit_stop "The code could not be checked." "$1 has had too many tries from this device in the last minute." "wait a minute, then run the same command again."
            fi
            kit_stop "This code is not valid any more." "" "get a new command from the card it came from."
            ;;
        000 | "") kit_stop "The code could not be checked." "$1 did not answer from this device." "check the network, then run the same command again." ;;
        *) kit_stop "The code could not be checked." "$1 answered with HTTP $kit_status." "run the same command again in a minute." ;;
    esac
    kit_kind=""
    while IFS= read -r kit_line; do
        kit_value="${kit_line#*=}"
        case "$kit_line" in
            KIND=*) kit_kind="$kit_value" ;;
            SANDBOX_URL=*) SANDBOX_URL="$kit_value" ;;
            PAIR_TOKEN=*) PAIR_TOKEN="$kit_value" ;;
            SYNC_DIR=*) SYNC_DIR="$kit_value" ;;
            TAKEOVER=*) TAKEOVER="$kit_value" ;;
            CONNECT_TOKEN=*) CONNECT_TOKEN="$kit_value" ;;
            ZONE=*) ZONE="$kit_value" ;;
            HOST_NAME=*) HOST_NAME="$kit_value" ;;
            HOST_ID=*) HOST_ID="$kit_value" ;;
        esac
    done <<KIT_ANSWER
$kit_body
KIT_ANSWER
    if [ "$kit_kind" != "$3" ]; then
        kit_stop "This code belongs to another command." "it connects a ${kit_kind:-different thing}, and this command connects a $3." "get a new command from the card it came from."
    fi
    kit_settle
}
