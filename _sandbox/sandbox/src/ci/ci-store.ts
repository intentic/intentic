import { randomBytes } from "node:crypto";
import { MainFailureDecisionSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { at, drop, mapValue, rename } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Daemon-recorded CI state in .intentic/secrets/ci.json: the webhook secret, each repo+branch's last terminal
// conclusion (drives pipeline_fixed/pipeline_broken), the poller's already-announced run ids, each main-line branch
// failing now with the newest run of each workflow that passed on it, what the forge says of each repository (its id,
// path and default branch), and the runs re-run for the fleet. Carries a secret, so it's a
// LOCKED_STATE_ENTRIES file like capabilities.json. No 'seen' flag: only a passing commit clears the rail badge.

// Caps stored conclusions; oldest-touched entries drop past this so the file doesn't grow forever.
const CONCLUSIONS_KEPT = 200;

// Announced run ids kept per repo; only needs to outlast RUNS_PER_POLL by a margin.
const ANNOUNCED_KEPT = 60;

// Fleet re-runs kept per repo; a run older than these is long past being heard of again.
const FLEET_RERUNS_KEPT = 50;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });

// One job failing on a main-line branch: its name, under the workflow it is a job of as its `source`, and an id derived
// from both (main-fixer.ts, findingOf), so the same job failing again in a later run is the same finding.
const CiFindingSchema = z.object({
    id: z.string(),
    source: z.string(),
    text: z.string(),
});
export type CiFinding = z.infer<typeof CiFindingSchema>;

// Main's CI failing on one branch, as its one fix agent's streak keeps it (main-fixer.ts): the jobs failing now are its
// findings, and the fix agent put on it and every hand-over are its decisions (contract, MainFailureDecisionSchema), with
// what the streak counts besides. Kept here rather than in memory, so a restart neither forgets a streak nor starts a
// second fix agent on it.
const CiFailureSchema = z.object({
    // When its first job failed, which began the streak.
    since: z.number(),
    findings: z.array(CiFindingSchema).default([]),
    // Oldest first.
    decisions: z.array(MainFailureDecisionSchema).default([]),
    // The run the streak began in, which names its fix agent (ciFixConversationId), and the newest run failing on it.
    firstRunId: z.number(),
    runId: z.number(),
    // How many runs have failed on it.
    count: z.number(),
    // Each workflow failing on it, with the newest run of it that failed: a later run of that workflow passing takes it
    // off, and the streak ends with the last one. Empty for a failure kept before 2026-09-27, which any passing run ends.
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
export type CiFailure = z.infer<typeof CiFailureSchema>;

// What the forge itself says of a repository (main-line.ts), learned at the hook reconcile and from every delivery. The
// id is its identity: a rename or a transfer keeps it, and changes only the path, which git and the API keep reaching
// through redirects, so a delivery is matched on the id and the path is display data.
const CiForgeSchema = z.object({
    // The project path the workspace's remote named when this was learned: a remote pointed elsewhere since is another
    // repository, and this says nothing of it.
    remote: z.string(),
    id: z.number().optional(),
    // Where the forge says the repository lives now.
    path: z.string().optional(),
    defaultBranch: z.string().optional(),
});
export type CiForge = z.infer<typeof CiForgeSchema>;
const CiStateSchema = z.object({
    secret: z.string().min(1),
    // Keyed "<repo>\n<branch>": \n can't appear in either half, so the key can't collide.
    conclusions: z.record(z.string(), ConclusionSchema),
    // Absent means never polled (suppresses the backlog storm); empty means polled with none found, not re-seeded.
    announced: z.record(z.string(), z.array(z.number())).optional(),
    // Keyed like `conclusions`; only branches failing right now.
    failures: z.record(z.string(), CiFailureSchema).optional(),
    // Keyed like `conclusions`: the newest run of each workflow that passed on a main-line branch, so a failure an older
    // run reports afterwards is not taken for main's word.
    passes: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    // Keyed by workspace repo.
    forges: z.record(z.string(), CiForgeSchema).optional(),
    // Keyed by workspace repo: the runs re-run because the CI fleet, not the code, failed them, newest first, so a run is
    // re-run once however many restarts hear of it. Bounded.
    fleetReruns: z.record(z.string(), z.array(z.number())).optional(),
});
type CiState = z.infer<typeof CiStateSchema>;

// Decision kinds only the check after landing made, retired with it on 2026-09-27; a CI failure never held one, and
// would read as the nearest that remain.
const RETIRED_DECISIONS = { waiting: "reported", held: "reported", original: "fix-up" } as const;

// Decision kinds only a failed push made (a later measurement found its findings gone, a person set them aside),
// retired with the push checks on 2026-09-28; a CI failure never held one either, and would read as the nearest that
// remains.
const PUSH_DECISIONS = { resolved: "reported", dismissed: "reported" } as const;

export const ciDocument = defineDocument({
    path: stateRelPath(".intentic/secrets/ci.json"),
    schema: CiStateSchema,
    history: [
        // The repair gate's failure (2026-09-27): who it was laid at, whether blame narrowed it, and when the newest run
        // was seen, which its quiet window waited from. A failing main now has one fix agent from its first failed job.
        at("reds.*", drop("suspects")),
        at("reds.*", drop("named")),
        at("reds.*", drop("seenAt")),
        at("reds.*.decisions.*", mapValue("kind", RETIRED_DECISIONS)),
        // Until 2026-09-28 main's failure shared one record with a push's: what a push check printed about each finding,
        // and the findings a decision was about. With the push checks gone, main's failure keeps its own: a finding for
        // each failed job, and every decision about the whole failure.
        at("reds.*.findings.*", drop("path")),
        at("reds.*.findings.*", drop("command")),
        at("reds.*.findings.*", drop("recheckable")),
        at("reds.*.findings.*", drop("gate")),
        at("reds.*.findings.*", drop("commit")),
        at("reds.*.decisions.*", drop("findings")),
        at("reds.*.decisions.*", mapValue("kind", PUSH_DECISIONS)),
        // Until 2026-09-28 the branches failing now were kept as `reds`, and the newest pass of each workflow as
        // `greens`: a CI run fails or passes, and the file says so in those words.
        rename("reds", "failures"),
        rename("greens", "passes"),
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
    // The main-line branches whose CI fails now, keyed "<repo>\n<branch>".
    readonly failures: () => Promise<Readonly<Record<string, CiFailure>>>;
    // Changes one branch's failure; undefined forgets it. Answers the failure as it now stands.
    readonly failure: (
        repo: string,
        branch: string,
        change: (current: CiFailure | undefined) => CiFailure | undefined,
    ) => Promise<CiFailure | undefined>;
    // The newest run of each workflow that passed on the branch.
    readonly passes: (repo: string, branch: string) => Promise<Readonly<Record<string, number>>>;
    // Records a pass, keeping the newest per workflow.
    readonly recordPass: (repo: string, branch: string, workflow: string, runId: number) => Promise<void>;
    // What the forge said of each repository, keyed by workspace repo.
    readonly forges: () => Promise<Readonly<Record<string, CiForge>>>;
    // Merges what the forge said of a repository its remote names `remote`; a fact learned for another remote is
    // replaced, not merged. Writes nothing when it says nothing new, since every delivery says it again.
    readonly learnForge: (repo: string, remote: string, fact: Omit<CiForge, "remote">) => Promise<void>;
    // Records a fleet re-run of the run, answering whether it is the first: false means it was re-run before.
    readonly fleetRerun: (repo: string, runId: number) => Promise<boolean>;
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
        recordConclusion: async (repo, branch, status, now) => {
            await file.update((state) => {
                const conclusions = { ...state.conclusions, [keyOf(repo, branch)]: { status, at: now } };
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
        failures: async () => (await file.read()).failures ?? {},
        failure: async (repo, branch, change) => {
            const key = keyOf(repo, branch);
            const state = await file.update((current) => {
                const next = change(current.failures?.[key]);
                const { [key]: _previous, ...others } = current.failures ?? {};
                return { ...minted(current), failures: next === undefined ? others : { ...others, [key]: next } };
            });
            return state.failures?.[key];
        },
        passes: async (repo, branch) => (await file.read()).passes?.[keyOf(repo, branch)] ?? {},
        recordPass: async (repo, branch, workflow, runId) => {
            await file.update((state) => {
                const key = keyOf(repo, branch);
                const known = state.passes?.[key] ?? {};
                if ((known[workflow] ?? 0) >= runId) {
                    return state;
                }
                return { ...minted(state), passes: { ...state.passes, [key]: { ...known, [workflow]: runId } } };
            });
        },
        forges: async () => (await file.read()).forges ?? {},
        learnForge: async (repo, remote, fact) => {
            const merged = (current: CiForge | undefined): CiForge => {
                const kept: CiForge = current?.remote === remote ? current : { remote };
                return { ...kept, ...Object.fromEntries(Object.entries(fact).filter(([, value]) => value !== undefined)), remote };
            };
            const same = (current: CiForge | undefined): boolean => JSON.stringify(merged(current)) === JSON.stringify(current);
            if (same((await file.read()).forges?.[repo])) {
                return;
            }
            await file.update((state) =>
                same(state.forges?.[repo]) ? state : { ...minted(state), forges: { ...state.forges, [repo]: merged(state.forges?.[repo]) } },
            );
        },
        fleetRerun: async (repo, runId) => {
            let first = false;
            await file.update((state) => {
                const known = state.fleetReruns?.[repo] ?? [];
                if (known.includes(runId)) {
                    return state;
                }
                first = true;
                return { ...minted(state), fleetReruns: { ...state.fleetReruns, [repo]: [runId, ...known].slice(0, FLEET_RERUNS_KEPT) } };
            });
            return first;
        },
        recordAnnounced: async (repo, runIds) => {
            await file.update((state) => ({
                ...minted(state),
                announced: { ...state.announced, [repo]: [...new Set(runIds)].slice(0, ANNOUNCED_KEPT) },
            }));
        },
    };
};
