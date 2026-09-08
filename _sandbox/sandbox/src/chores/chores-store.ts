import type { ChoreLedgerEntry, ProbeId, ProbeResult } from "@intentic/sandbox-contract";
import { ChoreLedgerEntrySchema, ProbeResultSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";

// Persists two files under .intentic/records/chores/: a probe cache and a ledger of actions. In .intentic, not a repo,
// since both are point-in-time evidence shared with isolated turns. One file each, not per-repo, since the rail badge
// reads them whole on every poll.

export const PROBES_FILE = stateRelPath(".intentic/records/chores/", "probes.json");
export const LEDGER_FILE = stateRelPath(".intentic/records/chores/", "ledger.json");

// repo -> probe id -> its last result; the workspace's own root repo is keyed by the empty string.
const ProbeCacheSchema = z.record(z.string(), z.record(z.string(), ProbeResultSchema));
export type ProbeCache = z.infer<typeof ProbeCacheSchema>;

export interface ChoresStore {
    readonly probes: () => Promise<ProbeCache>;
    readonly probesFor: (repo: string) => Promise<ProbeResult[]>;
    readonly recordProbe: (repo: string, result: ProbeResult) => Promise<void>;
    readonly ledger: () => Promise<ChoreLedgerEntry[]>;
    // Upserts by repo + chore: one current verdict, no growing history of past runs.
    readonly recordLedger: (entry: ChoreLedgerEntry) => Promise<void>;
    // Drops cached results for repos that no longer exist, so a deleted clone's data doesn't linger.
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

// Retry lease for a failed/unavailable probe (not a real measurement), distinct from an ok result's TTL.
const RETRY_MS = 3_600_000;

// A result is stale once older than its lease (TTL for ok, RETRY_MS otherwise). Shared by the runner and the on-demand
// route so "stale" can't drift between them.
export const isStale = (result: ProbeResult | undefined, ttlMs: number, nowMs: number): boolean =>
    result === undefined || nowMs - result.ranAt >= (result.state === "ok" ? ttlMs : RETRY_MS);

export const probeOf = (cache: ProbeCache, repo: string, id: ProbeId): ProbeResult | undefined => cache[repo]?.[id];
