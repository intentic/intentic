import { randomBytes } from "node:crypto";
import { RedSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { at, drop, mapValue } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Daemon-recorded CI state in .intentic/secrets/ci.json: the webhook secret, each repo+branch's last terminal
// conclusion (drives pipeline_fixed/pipeline_broken), the poller's already-announced run ids, and main's reds with the
// newest run of each workflow that passed on main. Carries a secret, so it's a LOCKED_STATE_ENTRIES file like
// capabilities.json. No 'seen' flag: only a passing commit clears the rail badge.

// Caps stored conclusions; oldest-touched entries drop past this so the file doesn't grow forever.
const CONCLUSIONS_KEPT = 200;

// Announced run ids kept per repo; only needs to outlast RUNS_PER_POLL by a margin.
const ANNOUNCED_KEPT = 60;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });

// Main's CI red on one branch, as its one fix agent's streak keeps it (main-fixer.ts): the Red (contract, RedSchema: the
// jobs failing now are its findings, each under the workflow it is a job of as its `source`; the fix agent put on it and
// every hand-over are its decisions), with what the streak counts besides. Kept here rather than in memory, so a restart
// neither forgets a streak nor starts a second fix agent on it.
const CiRedSchema = RedSchema.omit({ source: true, scope: true }).extend({
    // The run the streak began in, which names its fix agent (ciFixConversationId), and the newest run failing on it.
    firstRunId: z.number(),
    runId: z.number(),
    // How many runs have failed on it.
    count: z.number(),
    // Each workflow red on it, with the newest run of it that failed: a later run of that workflow passing takes it off,
    // and the streak ends with the last one. Empty for a red kept before 2026-09-27, which any passing run ends.
    workflows: z.record(z.string(), z.number()).default({}),
    // Every failed job the streak has heard of, as `<runId>/<jobId>`, oldest first: each is handled once, however many
    // ways it arrives (its own webhook, its run's, the poller). Bounded.
    heard: z.array(z.string()).default([]),
    // Turns the sandbox started for its fix agent this streak; words said into a live turn are none. A person's Fix press
    // gives them back.
    turns: z.number().default(0),
    // Whether its fix agent has left a change this streak (held on its branch or landed), so a later turn that finds
    // nothing left to change is not read as a failure it cannot fix.
    changed: z.boolean().default(false),
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
    // Keyed like `conclusions`: the newest run of each workflow that passed on a main-line branch, so a failure an older
    // run reports afterwards is not taken for main's word.
    greens: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});
type CiState = z.infer<typeof CiStateSchema>;

// Decision kinds only the check after landing made, retired with it on 2026-09-27; a CI red never held one, and would
// read as the nearest that remain.
const RETIRED_DECISIONS = { waiting: "reported", held: "reported", original: "fix-up" } as const;

export const ciDocument = defineDocument({
    path: stateRelPath(".intentic/secrets/ci.json"),
    schema: CiStateSchema,
    history: [
        // The repair gate's red (2026-09-27): who it was laid at, whether blame narrowed it, and when the newest run was
        // seen, which its quiet window waited from. Main's red now has one fix agent from its first failed job.
        at("reds.*", drop("suspects")),
        at("reds.*", drop("named")),
        at("reds.*", drop("seenAt")),
        at("reds.*.decisions.*", mapValue("kind", RETIRED_DECISIONS)),
    ],
});

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
    // Changes one branch's red; undefined forgets it. Answers the red as it now stands.
    readonly red: (repo: string, branch: string, change: (current: CiRed | undefined) => CiRed | undefined) => Promise<CiRed | undefined>;
    // The newest run of each workflow that passed on the branch.
    readonly greens: (repo: string, branch: string) => Promise<Readonly<Record<string, number>>>;
    // Records a pass, keeping the newest per workflow.
    readonly green: (repo: string, branch: string, workflow: string, runId: number) => Promise<void>;
}

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

// Fills the secret if absent, applied inside `update` so two concurrent first callers can't mint two different secrets.
const minted = (state: CiState): CiState => (state.secret === "" ? { ...state, secret: randomBytes(32).toString("hex") } : state);

export const fileCiStore = (path: string): CiStore => {
    const file = openDocument<typeof ciDocument, CiState>(ciDocument, path, {
        unknownKeys: true,
        // Empty secret marks no file yet; `minted` fills it inside the update queue so callers can't mint two.
        fallback: () => ({ secret: "", conclusions: {} }),
        mode: 0o600,
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
            const key = keyOf(repo, branch);
            const state = await file.update((current) => {
                const next = change(current.reds?.[key]);
                const { [key]: _previous, ...others } = current.reds ?? {};
                return { ...minted(current), reds: next === undefined ? others : { ...others, [key]: next } };
            });
            return state.reds?.[key];
        },
        greens: async (repo, branch) => (await file.read()).greens?.[keyOf(repo, branch)] ?? {},
        green: async (repo, branch, workflow, runId) => {
            await file.update((state) => {
                const key = keyOf(repo, branch);
                const known = state.greens?.[key] ?? {};
                if ((known[workflow] ?? 0) >= runId) {
                    return state;
                }
                return { ...minted(state), greens: { ...state.greens, [key]: { ...known, [workflow]: runId } } };
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
