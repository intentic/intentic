import { randomBytes } from "node:crypto";
import { RedSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import { stateRelPath } from "../state-paths.js";

// Daemon-recorded CI state in .intentic/secrets/ci.json: the webhook secret, each repo+branch's last terminal
// conclusion (drives pipeline_fixed/pipeline_broken), and the poller's already-announced run ids. Carries a secret, so
// it's a LOCKED_STATE_ENTRIES file like capabilities.json. No 'seen' flag: only a passing commit clears the rail badge.

// Caps stored conclusions; oldest-touched entries drop past this so the file doesn't grow forever.
const CONCLUSIONS_KEPT = 200;

// Announced run ids kept per repo; only needs to outlast RUNS_PER_POLL by a margin.
const ANNOUNCED_KEPT = 60;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });

// Main's CI red on one branch, as the repair gate keeps it (repair-gate.ts): the Red (contract, RedSchema: the failed
// jobs are its findings, a fix it started is its decision), with the run its streak began with, which names the fix, the
// newest run of it, how many runs it holds, and when the newest was seen, which the quiet window is measured from. Kept
// here rather than in memory, so a restart neither forgets a streak nor starts a second fix on it.
const CiRedSchema = RedSchema.omit({ source: true, scope: true }).extend({
    count: z.number(),
    firstRunId: z.number(),
    runId: z.number(),
    seenAt: z.number(),
});
export type CiRed = z.infer<typeof CiRedSchema>;
const CiStateSchema = z.object({
    secret: z.string().min(1),
    // Keyed "<repo>\n<branch>": \n can't appear in either half, so the key can't collide.
    conclusions: z.record(z.string(), ConclusionSchema),
    // Absent means never polled (suppresses the backlog storm); empty means polled with none found, not re-seeded.
    announced: z.record(z.string(), z.array(z.number())).optional(),
    // Keyed like `conclusions`; only branches red right now.
    reds: z.record(z.string(), CiRedSchema).optional(),
});
type CiState = z.infer<typeof CiStateSchema>;

export const ciDocument = defineDocument({ path: stateRelPath(".intentic/secrets/ci.json"), schema: CiStateSchema });

export interface CiStore {
    // Minted on first read, stable after; hook registrations and signature checks must agree across boots.
    readonly secret: () => Promise<string>;
    readonly lastConclusion: (repo: string, branch: string) => Promise<"success" | "failed" | undefined>;
    readonly recordConclusion: (repo: string, branch: string, status: "success" | "failed", at: number) => Promise<void>;
    // Ids already announced for this repo, or undefined if never polled: "nothing new" vs "nothing known yet".
    readonly announcedRuns: (repo: string) => Promise<number[] | undefined>;
    // Newest-first; ids past ANNOUNCED_KEPT are forgotten.
    readonly recordAnnounced: (repo: string, runIds: readonly number[]) => Promise<void>;
    // Main's CI reds, keyed "<repo>\n<branch>".
    readonly reds: () => Promise<Readonly<Record<string, CiRed>>>;
    // Changes one branch's red; undefined forgets it.
    readonly red: (repo: string, branch: string, change: (current: CiRed | undefined) => CiRed | undefined) => Promise<void>;
}

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

// Fills the secret if absent, applied inside `update` so two concurrent first callers can't mint two different secrets.
const minted = (state: CiState): CiState => (state.secret === "" ? { ...state, secret: randomBytes(32).toString("hex") } : state);

export const fileCiStore = (path: string): CiStore => {
    const file = jsonFile<CiState>(path, {
        parse: objectParse(CiStateSchema),
        // Empty secret marks no file yet; `minted` fills it inside the update queue so callers can't mint two.
        fallback: () => ({ secret: "", conclusions: {} }),
        mode: 0o600,
        document: ciDocument,
    });
    return {
        secret: async () => (await file.update(minted)).secret,
        lastConclusion: async (repo, branch) => (await file.read()).conclusions[keyOf(repo, branch)]?.status,
        recordConclusion: async (repo, branch, status, at) => {
            await file.update((state) => {
                const conclusions = { ...state.conclusions, [keyOf(repo, branch)]: { status, at } };
                const keys = Object.keys(conclusions);
                for (const stale of keys
                    .toSorted((a, b) => (conclusions[a]?.at ?? 0) - (conclusions[b]?.at ?? 0))
                    .slice(0, Math.max(0, keys.length - CONCLUSIONS_KEPT))) {
                    delete conclusions[stale];
                }
                return { ...minted(state), conclusions };
            });
        },
        announcedRuns: async (repo) => (await file.read()).announced?.[repo],
        reds: async () => (await file.read()).reds ?? {},
        red: async (repo, branch, change) => {
            await file.update((state) => {
                const key = keyOf(repo, branch);
                const next = change(state.reds?.[key]);
                const { [key]: _previous, ...others } = state.reds ?? {};
                return { ...minted(state), reds: next === undefined ? others : { ...others, [key]: next } };
            });
        },
        recordAnnounced: async (repo, runIds) => {
            await file.update((state) => ({
                ...minted(state),
                announced: { ...state.announced, [repo]: [...new Set(runIds)].slice(0, ANNOUNCED_KEPT) },
            }));
        },
    };
};
