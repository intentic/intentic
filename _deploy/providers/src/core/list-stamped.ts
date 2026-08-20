import type { ListedResource, ScanSource } from "@intentic/engine";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor } from "./ssh.js";

// One stamped container row: which provider family stamped it, its resource id, and protection.
interface StampedRow {
    readonly type: string;
    readonly id: string;
    readonly protected: boolean;
}

// The whole scan's per-host stamped-container table, fetched ONCE and shared by every list-bearing provider,
// keyed on the scan's shared `sources` array (collectOrphans builds it once and hands the same array to every
// provider's list). A dozen-plus providers each opening their own SSH connection serially is the single
// longest silent stretch of a plan (~1s per connect over cloudflared); one connect + one `docker ps` serves
// them all. The promise itself is cached, so a host is dialed exactly once per scan, success or failure.
const tablesByScan = new WeakMap<readonly ScanSource[], Map<string, Promise<readonly StampedRow[]>>>();

// Fetch every intentic-stamped container on one host in a single exec: `-a` includes stopped containers (a
// stopped orphan still holds volumes/state). Best-effort: an unreachable host is logged once and reads as
// empty, a scan must not fail the run.
const fetchHostTable = async (executor: SshExecutor, source: ScanSource, log: (message: string) => void): Promise<readonly StampedRow[]> => {
    let session;
    try {
        session = await executor.connect(sshTarget(parseInputs(sshSchema, source.inputs, "host")));
    } catch (error) {
        log(`orphan scan: host "${source.id}" not reachable over SSH, skipping it for this scan: ${String(error)}`);
        return [];
    }
    try {
        const result = await session.exec(
            `docker ps -a --filter "label=intentic.type" --format '{{.Label "intentic.type"}}\t{{.Label "intentic.id"}}\t{{.Label "intentic.protect"}}'`,
        );
        const rows: StampedRow[] = [];
        for (const line of result.stdout.trim().split("\n")) {
            const [type, id, protect] = line.split("\t");
            if (type === undefined || type === "" || id === undefined || id === "") {
                continue;
            }
            rows.push({ type, id, protected: protect === "true" });
        }
        return rows;
    } finally {
        await session.dispose();
    }
};

// The docker family's shared `list`: enumerate the intentic.type=<kind> stamped containers across every
// host source, served from the per-scan table above. Each entry pairs the container's intentic.id stamp with
// the host's SSH block, exactly what the family's `delete` parses, so whatever `list` finds, `delete` can
// tear down (the collection contract).
export const listStampedContainers = async (
    executor: SshExecutor,
    kind: string,
    sources: readonly ScanSource[],
    log: (message: string) => void,
): Promise<ListedResource[]> => {
    let tables = tablesByScan.get(sources);
    if (tables === undefined) {
        tables = new Map();
        tablesByScan.set(sources, tables);
    }
    // Kick off every host's fetch before awaiting any, so the connects (the plan's longest silent stretch,
    // ~1s each over cloudflared) run concurrently across hosts instead of serially.
    const hostSources = sources.filter((source) => source.type === "host");
    for (const source of hostSources) {
        if (!tables.has(source.id)) {
            tables.set(source.id, fetchHostTable(executor, source, log));
        }
    }
    const fetched = await Promise.all(hostSources.map((source) => tables.get(source.id) ?? []));
    const entries: ListedResource[] = [];
    for (const [index, source] of hostSources.entries()) {
        // One entry per (stamp, host): the same stamp on two hosts is two resources to tear down.
        const seen = new Set<string>();
        for (const row of fetched[index] ?? []) {
            if (row.type !== kind || seen.has(row.id)) {
                continue;
            }
            seen.add(row.id);
            entries.push({ id: row.id, inputs: source.inputs, ...(row.protected ? { protected: true } : {}) });
        }
    }
    return entries;
};
