/* WHICH STOPPED CONTAINERS ARE CI'S TO REMOVE. Only what CI leaves behind: a container of a compose project (a Komodo
   stack, the platform) or of an Intentic sandbox or runner (`dev.intentic.kind`) is a deployment, stopped or asleep,
   never CI's. `container prune --filter until=24h` took any stopped container created a day ago, and the volume prune
   then took its named volumes in the same pass: on z440 a Komodo-run sandbox the keeper had put to sleep (2026-11-12,
   1.3 GB) and the auto-translate stack's data after a reboot (2026-11-17, 9.7 GB). Same rule as wsl-maintenance.ps1 on
   omen. Listed and chosen here rather than passed as two `label!=` filters to `container prune`: with several, docker
   skips a container only if it carries all of them. */

export const CONTAINER_LS_ARGS: readonly string[] = [
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--filter",
    "status=exited",
    "--filter",
    "status=created",
    "--filter",
    "status=dead",
    "--format",
    '{{.ID}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "dev.intentic.kind"}}',
];

// How long a stopped CI container is kept: a day, as the old `until=24h`.
const KEEP_MS = 24 * 3_600_000;

/** docker's CreatedAt, "2026-11-17 10:27:39 -0500 EST", in ms; undefined for one that does not read. */
export const createdAtMs = (text: string): number | undefined => {
    const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-])(\d\d)(\d\d)\b/u.exec(text.trim());
    if (match === null) {
        return undefined;
    }
    const [, day, time, sign, hours, minutes] = match;
    const ms = Date.parse(`${day}T${time}${sign}${hours}:${minutes}`);
    return Number.isNaN(ms) ? undefined : ms;
};

/** The ids of stopped containers no deployment owns and created over a day ago; one whose date does not read counts as
 *  young and stays. */
export const ciContainersToRemove = (stdout: string, now: number): string[] => {
    const ids: string[] = [];
    for (const line of stdout.split(/\r?\n/u)) {
        const [id = "", created = "", project = "", kind = ""] = line.split("\t");
        const at = createdAtMs(created);
        if (id !== "" && project === "" && kind === "" && at !== undefined && at < now - KEEP_MS) {
            ids.push(id);
        }
    }
    return ids;
};
