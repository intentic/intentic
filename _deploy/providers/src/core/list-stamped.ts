import type { ListedResource, ProviderContext, ScanSource } from "@intentic/engine";
import { OWNER_KEY } from "@intentic/graph";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";

// One stamped container row: provider family, resource id, protection, and owning intent ("" when unstamped).
export interface StampedRow {
    readonly type: string;
    readonly id: string;
    readonly protected: boolean;
    readonly owner: string;
}

// Every intentic-stamped container on the host in one exec; `-a` includes stopped containers, since an orphan can still
// hold volumes. A failed `docker ps` throws: an empty listing would read as "nothing of ours here".
const STAMPED_TABLE = `docker ps -a --filter "label=intentic.type" --format '{{.Label "intentic.type"}}\t{{.Label "intentic.id"}}\t{{.Label "intentic.protect"}}\t{{.Label "${OWNER_KEY}"}}'`;

export const readStampedTable = async (session: SshSession): Promise<readonly StampedRow[]> => {
    const result = await session.exec(STAMPED_TABLE);
    if (result.code !== 0) {
        throw new Error(`listing stamped containers failed: exited ${result.code}: ${result.stderr.trim()}`);
    }
    const rows: StampedRow[] = [];
    for (const line of result.stdout.trim().split("\n")) {
        const [type, id, protect, owner = ""] = line.split("\t");
        if (type === undefined || type === "" || id === undefined || id === "") {
            continue;
        }
        rows.push({ type, id, protected: protect === "true", owner: owner.trim() });
    }
    return rows;
};

// The strict listing of one host, for a caller that must tell "nothing there" from "could not look" (a retired host
// confirmed clean): an unreachable host or a failed listing throws.
export const listHostStamps = async (executor: SshExecutor, target: SshTarget): Promise<readonly StampedRow[]> => {
    const session = await executor.connect(target);
    try {
        return await readStampedTable(session);
    } finally {
        await session.dispose();
    }
};

type ScanContext = Pick<ProviderContext, "log" | "skipped">;

// Per-host stamped-container cache for one scan, keyed by the scan's `sources` array; dials each host once.
const tablesByScan = new WeakMap<readonly ScanSource[], Map<string, Promise<readonly StampedRow[]>>>();

// Best-effort for the orphan scan: an unreachable host, or one whose listing fails, is logged once and reported as a
// skipped source, then reads as empty, so it prunes nothing rather than failing the scan.
const fetchHostTable = async (executor: SshExecutor, source: ScanSource, ctx: ScanContext): Promise<readonly StampedRow[]> => {
    let session;
    try {
        session = await executor.connect(sshTarget(parseInputs(sshSchema, source.inputs, "host")));
    } catch (error) {
        ctx.log(`orphan scan: host "${source.id}" not reachable over SSH, skipping it for this scan: ${String(error)}`);
        ctx.skipped?.(source.id, "not reachable over SSH");
        return [];
    }
    try {
        return await readStampedTable(session);
    } catch (error) {
        ctx.log(`orphan scan: host "${source.id}" could not be listed, skipping it for this scan: ${String(error)}`);
        ctx.skipped?.(source.id, "its container listing failed");
        return [];
    } finally {
        await session.dispose();
    }
};

// Docker family's shared `list`: enumerates intentic.type=<kind> stamped containers across every host source. Each
// entry pairs the intentic.id stamp and its owner with the host's SSH block, exactly what `delete` parses.
export const listStampedContainers = async (
    executor: SshExecutor,
    kind: string,
    sources: readonly ScanSource[],
    ctx: ScanContext,
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
            tables.set(source.id, fetchHostTable(executor, source, ctx));
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
            entries.push({
                id: row.id,
                inputs: source.inputs,
                ...(row.protected ? { protected: true } : {}),
                ...(row.owner !== "" ? { owner: row.owner } : {}),
            });
        }
    }
    return entries;
};
