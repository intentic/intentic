import type { ChoreLedgerEntry, ProbeId, ProbeResult } from "@intentic/sandbox-contract";
import { ChoreLedgerEntrySchema, ProbeResultSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { stateRelPath } from "../workspace/state-paths.js";

/* The two files the maintenance surface persists, both under <workspace>/.intentic/records/chores/ and both deliberately
 * boring: a cache of what the probes measured, and a ledger of what has been done about it.
 *
 * WHY .intentic AND NOT A REPO. Neither of these is an asset about the code — they are point-in-time evidence and
 * bookkeeping about agents, the same category as an acceptance run's reports. Putting them in a repo would mean
 * every probe refresh shows up as a diff someone has to not-commit, and the workspace root repo excludes
 * `.intentic` for exactly this reason. It also means they are shared with isolated turns (`.intentic` is bound
 * back SHARED), so a chore agent running in its own worktree writes its outcome where the browser will read it.
 *
 * WHY ONE FILE EACH, NOT ONE PER REPO. Both are read whole on every poll — the rail badge scans every repo's
 * verdicts on a timer — so N files would be N reads a minute to answer one question. They are kilobytes; the
 * probe cache holds a handful of results per repo and the ledger holds one row per repo × chore, capped by the
 * catalog's size rather than by time. Nothing here grows without bound. */

export const PROBES_FILE = stateRelPath(".intentic/records/chores/", "probes.json");
export const LEDGER_FILE = stateRelPath(".intentic/records/chores/", "ledger.json");

// repo → probe id → its last completed result. The repo key is the root-relative dir, with the workspace's own
// root repo keyed by the empty string exactly as it is everywhere else in the daemon.
const ProbeCacheSchema = z.record(z.string(), z.record(z.string(), ProbeResultSchema));
export type ProbeCache = z.infer<typeof ProbeCacheSchema>;

export interface ChoresStore {
    readonly probes: () => Promise<ProbeCache>;
    readonly probesFor: (repo: string) => Promise<ProbeResult[]>;
    readonly recordProbe: (repo: string, result: ProbeResult) => Promise<void>;
    readonly ledger: () => Promise<ChoreLedgerEntry[]>;
    // Upsert by repo + chore. A chore has one current verdict; a growing history of "we looked and it was fine"
    // is not something any reader wants paged, and the run itself stays readable in the fleet either way.
    readonly recordLedger: (entry: ChoreLedgerEntry) => Promise<void>;
    // Drop cached results for repos that no longer exist, so a deleted clone's measurements don't outlive it and
    // reappear in the panel as a repository nobody can open.
    readonly pruneProbes: (repos: readonly string[]) => Promise<void>;
}

export const fileChoresStore = (probesPath: string, ledgerPath: string): ChoresStore => {
    const probeFile = jsonFile<ProbeCache>(probesPath, { parse: (raw) => ProbeCacheSchema.safeParse(raw).data, fallback: () => ({}) });
    const ledgerFile = jsonFile<ChoreLedgerEntry[]>(ledgerPath, {
        parse: (raw) => z.array(ChoreLedgerEntrySchema).safeParse(raw).data,
        fallback: () => [],
    });
    return {
        probes: probeFile.read,
        probesFor: async (repo) => Object.values((await probeFile.read())[repo] ?? {}),
        recordProbe: async (repo, result) => {
            await probeFile.update((cache) => ({ ...cache, [repo]: { ...cache[repo], [result.id]: result } }));
        },
        ledger: ledgerFile.read,
        recordLedger: async (entry) => {
            await ledgerFile.update((entries) => [...entries.filter((row) => !(row.repo === entry.repo && row.chore === entry.chore)), entry]);
        },
        pruneProbes: async (repos) => {
            const live = new Set(repos);
            await probeFile.update((cache) => {
                const kept = Object.entries(cache).filter(([repo]) => live.has(repo));
                // Unchanged by reference when nothing was dropped, so the common case writes nothing.
                return kept.length === Object.keys(cache).length ? cache : Object.fromEntries(kept);
            });
        },
    };
};

/* How long a result that is NOT a measurement holds its slot before the runner tries again. A `failed` or
 * `unavailable` probe is a record of not having measured, and leasing it like a measurement is what pinned a
 * tier-2 parse failure to the Maintenance panel for a week — long after its cause (a tool still installing, a
 * network-less audit, output this build's parser has since learned to read) stopped being true.
 *
 * An hour is short enough that a cause fixed in the morning self-heals the same day, and still a real rate limit:
 * the sweep ticks every 30 minutes and refuses to run at all while a turn is live, so the worst case on an idle
 * machine is one retry an hour. The same lease for both — an `unavailable` probe stops after its `available`
 * check, which is the cheapest thing the runner does, and re-checking it hourly is how a repo that just added
 * knip gets measured today rather than next week. */
const RETRY_MS = 3_600_000;

// A probe's result is stale once it is older than its lease. Split out because the runner and the on-demand route
// both ask it, and "is this fresh enough" drifting between the two would mean a forced refresh that silently does
// nothing.
export const isStale = (result: ProbeResult | undefined, ttlMs: number, nowMs: number): boolean =>
    result === undefined || nowMs - result.ranAt >= (result.state === "ok" ? ttlMs : RETRY_MS);

export const probeOf = (cache: ProbeCache, repo: string, id: ProbeId): ProbeResult | undefined => cache[repo]?.[id];
