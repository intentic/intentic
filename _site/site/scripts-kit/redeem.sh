# kit_redeem <host> <code> <kind>: spend a single-use code at the sandbox that minted it, before anything is downloaded,
# so a dead code fails in a second. The answer is `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), read
# into the very variables a run started from the environment uses: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER,
# CONNECT_TOKEN, ZONE, HOST_NAME. Only those keys are taken, and nothing is evaluated.
kit_redeem() {
    case "$1" in
        "" | *[!A-Za-z0-9.-]*) kit_stop "This command is not complete." "$1 is not the address of a sandbox." "get a new command from the card it came from." ;;
    esac
    case "$2" in
        "" | *[!A-Za-z0-9-]*) kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
    esac
    kit_step "" "checking the code with $1…" "Check the code for $1"
    kit_reply="$(curl -s -X POST --max-time 30 -w '\n%{http_code}' "https://$1/system/redeem/$2" 2>/dev/null || true)"
    kit_status="$(printf '%s\n' "$kit_reply" | tail -n 1)"
    kit_body="$(printf '%s\n' "$kit_reply" | sed '$d')"
    case "$kit_status" in
        200) ;;
        404 | 429)
            # One sentence from the sandbox, "<what happened>: <what to do>".
            kit_said="$(printf '%s\n' "$kit_body" | head -n 1)"
            case "$kit_said" in
                *": "*) kit_stop "${kit_said%%: *}." "" "${kit_said#*: }" ;;
                "") kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
                *) kit_stop "$kit_said" "" "get a new command from the card it came from." ;;
            esac
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
        esac
    done <<KIT_ANSWER
$kit_body
KIT_ANSWER
    if [ "$kit_kind" != "$3" ]; then
        kit_stop "This code belongs to another command." "it connects a ${kit_kind:-different thing}, and this command connects a $3." "get a new command from the card it came from."
    fi
    kit_settle
}
