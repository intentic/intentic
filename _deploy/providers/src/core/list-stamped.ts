import type { ListedResource, ScanSource } from "@intentic/engine";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor } from "./ssh.js";

// One stamped container row: provider family, resource id, and protection.
interface StampedRow {
    readonly type: string;
    readonly id: string;
    readonly protected: boolean;
}

// Per-host stamped-container cache for one scan, keyed by the scan's `sources` array; dials each host once.
const tablesByScan = new WeakMap<readonly ScanSource[], Map<string, Promise<readonly StampedRow[]>>>();

// Fetches every intentic-stamped container on one host in a single exec; `-a` includes stopped containers, since an
// orphan can still hold volumes. Best-effort: an unreachable host logs once and reads as empty rather than failing the
// scan.
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

// Docker family's shared `list`: enumerates intentic.type=<kind> stamped containers across every host source. Each
// entry pairs the intentic.id stamp with the host's SSH block, exactly what `delete` parses.
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
    // Kicks off every host's fetch before awaiting any, so connects run concurrently rather than serially.
    const hostSources = sources.filter((source) => source.type === "host");
    for (const source of hostSources) {
        if (!tables.has(source.id)) {
            tables.set(source.id, fetchHostTable(executor, source, log));
        }
    }
    const fetched = await Promise.all(hostSources.map((source) => tables.get(source.id) ?? []));
    const entries: ListedResource[] = [];
    for (const [index, source] of hostSources.entries()) {
        // One entry per (stamp, host); the same stamp on two hosts is two resources to tear down.
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
