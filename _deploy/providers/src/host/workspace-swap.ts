import { HISTORY_ROOT, HOST_STATE_ROOT } from "@intentic/constants";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Runs inside the container: exit 0 ready; 1 not yet; 2 failed for good; 3 converting; 5/6 reach regressed or unsettled.
const healthProbe = (port: number): string => {
    return `
import { readFile } from "node:fs/promises";
// A file that is not there yet is normal early in a boot; one that is there but unreadable is logged, then treated as absent.
const jsonFile = (path) => readFile(path, "utf8").then(JSON.parse).catch((error) => {
    if (error?.code !== "ENOENT") console.error(path, String(error));
    return undefined;
});
const vitals = await jsonFile("/run/intentic/vitals.json");
if (vitals?.node !== "up" && vitals?.restarts >= 3) process.exit(2);
const failure = await jsonFile("${HISTORY_ROOT}/boot-failure.json");
if (failure?.at >= Number(process.env.INTENTIC_CUTOVER_AT) * 1000) process.exit(2);
try {
    const response = await fetch("http://127.0.0.1:${port}/health", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) process.exit(1);
    const health = await response.json();
    if (health.state?.journal === "failed") process.exit(2);
    if (health.state?.journal === "open") process.exit(3);
    if ((health.boot?.ready ?? health.ready) === false) process.exit(1);
    if (process.env.INTENTIC_PREVIOUS_REACH === "reachable") {
        if (health.reach?.state === "unreachable") process.exit(5);
        if (health.reach?.state === "checking") process.exit(6);
    }
    process.exit(0);
} catch {process.exit(1);}`;
};

const hostFunctions = (container: string, health: string): string => {
    const parked = `${container}-previous`;
    return `
container=${shellQuote(container)}
parked=${shellQuote(parked)}
had_old=false
previous_reach=\${previous_reach:-}
cutover_at=\${cutover_at:-0}
exists() { docker inspect "$1" >/dev/null 2>&1; }
restore() {
    if exists "$parked"; then
        docker logs --tail 2000 "$container" > ${HOST_STATE_ROOT}/workspace-failed.log 2>&1 || true
        docker rm -f "$container" >/dev/null 2>&1 || true
        docker rename "$parked" "$container" && docker start "$container" || return 1
        echo 'restored the previous workspace sandbox' >&2
    elif [ "$had_old" = true ]; then
        docker start "$container" || return 1
    fi
}
check() {
    restarts=$(docker inspect --format '{{.RestartCount}}' "$container") || return 1
    [ "$restarts" -lt 3 ] || return 2
    docker exec -e "INTENTIC_PREVIOUS_REACH=$previous_reach" -e "INTENTIC_CUTOVER_AT=$cutover_at" "$container" node --input-type=module -e ${shellQuote(health)}
}
`;
};

// The detached probation: a version that never settles is replaced by its predecessor, one that holds is kept.
const probationWatch = (functions: string): string => {
    return `${functions}
# Each look takes the cutover lock, and checks identity: an older watch never undoes a newer deploy.
printf "%s" "$expected" > ${HOST_STATE_ROOT}/workspace-watch.ready || exit 1
at=$(date +%s)
strikes=0
while [ $(($(date +%s) - at)) -lt 86400 ]; do
    sleep 60
    (
        flock -x 9
        [ "$(docker inspect --format '{{.Id}}' "$container" 2>/dev/null)" = "$expected" ] || exit 10
        # A deliberate stop (including idle sleep) is held, not counted as a failed version.
        [ "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container")" != "exited 0" ] || exit 0
        check && exit 0
        verdict=$?
        [ "$verdict" -eq 2 ] && { restore; exit 20; }
        age=$(($(date +%s) - at))
        # Conversions have a longer grace than a silent or not-ready daemon.
        grace=600
        [ "$verdict" -eq 3 ] && grace=900
        [ "$verdict" -eq 6 ] && grace=900
        [ "$age" -ge "$grace" ] || exit 0
        exit 1
    ) 9>${HOST_STATE_ROOT}/workspace-swap.lock
    verdict=$?
    [ "$verdict" -eq 10 ] && exit 0
    [ "$verdict" -eq 20 ] && exit 1
    if [ "$verdict" -eq 0 ]; then strikes=0; else strikes=$((strikes + 1)); fi
    if [ "$strikes" -ge 3 ]; then
        (flock -x 9; [ "$(docker inspect --format '{{.Id}}' "$container" 2>/dev/null)" != "$expected" ] || restore) 9>${HOST_STATE_ROOT}/workspace-swap.lock
        exit 1
    fi
done
# The rollback target survives until probation ends, even when apply itself ended hours earlier.
(flock -x 9; [ "$(docker inspect --format '{{.Id}}' "$container" 2>/dev/null)" != "$expected" ] || docker rm "$parked") 9>${HOST_STATE_ROOT}/workspace-swap.lock
`;
};

// The whole cutover lives on the host: losing the SSH client (including an apply running inside this sandbox)
// must still leave a process that can put its predecessor back. No image or volume is removed on failure.
export const workspaceSwapScript = (container: string, run: string, fallback: string, port: number): string => {
    const health = healthProbe(port);
    const functions = hostFunctions(container, health);
    const watch = probationWatch(functions);
    return `${functions}
command -v flock >/dev/null && command -v nohup >/dev/null || exit 1
mkdir -p ${HOST_STATE_ROOT} || exit 1
exec 9>${HOST_STATE_ROOT}/workspace-swap.lock
flock -n 9 || { echo 'a workspace cutover is already running' >&2; exit 1; }
trap 'exit 1' HUP INT TERM
trap 'restore' EXIT
# Finish an interrupted rename before attempting another cutover.
if ! exists "$container" && exists "$parked"; then restore || exit 1; fi
if exists "$container"; then
    # Never discard the only known-good predecessor for a version that has not become ready.
    if exists "$parked"; then check || restore || exit 1; fi
    had_old=true
    previous_reach=$(docker exec "$container" node --input-type=module -e ${shellQuote(`try {const response = await fetch("http://127.0.0.1:${port}/health", { signal: AbortSignal.timeout(5000) }); console.log((await response.json()).reach?.state ?? "");} catch (error) {console.error(String(error));}`)} 2>/dev/null) || true
    docker logs --tail 2000 "$container" > ${HOST_STATE_ROOT}/workspace-previous.log 2>&1 || true
    docker rm -f "$parked" >/dev/null 2>&1 || true
    docker stop "$container" || { docker start "$container"; exit 1; }
    docker rename "$container" "$parked" || { docker start "$container"; exit 1; }
fi
cutover_at=$(date +%s)
export previous_reach cutover_at
if ! ${run}; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    if ! ${fallback}; then exit 1; fi
fi
# The new daemon must finish its boot and commit the conversion journal before apply succeeds.
tries=0
ready=false
while [ "$tries" -lt 180 ]; do
    if check; then ready=true; break; else verdict=$?; fi
    [ "$verdict" -ne 2 ] || break
    tries=$((tries + 1))
    sleep 5
done
if [ "$ready" != true ]; then exit 1; fi
expected=$(docker inspect --format '{{.Id}}' "$container") || exit 1
export expected
# Close the cutover lock in the child; each probation look reacquires it for its own bounded work.
rm -f ${HOST_STATE_ROOT}/workspace-watch.ready
nohup sh -c ${shellQuote(watch)} </dev/null >>${HOST_STATE_ROOT}/workspace-probation.log 2>&1 9>&- &
# Do not surrender the immediate rollback guard until the detached watch has actually started.
started=false
for attempt in 1 2 3 4 5; do
    if [ "$(cat ${HOST_STATE_ROOT}/workspace-watch.ready 2>/dev/null)" = "$expected" ]; then started=true; break; fi
    sleep 1
done
[ "$started" = true ] || exit 1
trap - EXIT HUP INT TERM
`;
};
