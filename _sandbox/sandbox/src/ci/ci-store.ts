import { randomBytes } from "node:crypto";
import { CiFailureSchema, CiOwnerStepKeptSchema, type CiRepairHandOver } from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";
import { at, drop, mapValue, rename } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Daemon-recorded CI state in .intentic/secrets/ci.json: the webhook secret, each repo+branch's last terminal
// conclusion (drives pipeline_fixed/pipeline_broken), the poller's already-announced run ids, what the forge says of
// each repository (its id, path and default branch), and which extensions claim main lines' failures (main-line-claims.ts).
// Carries a secret, so it's a LOCKED_STATE_ENTRIES file like capabilities.json. No 'seen' flag: only a passing commit
// clears the rail badge. (2026-11-26) Until main's fix agent moved to the pipelines extension this file also kept its
// streaks (`failures`, `passes`, `fleetReruns`, `ownerSteps`): read now only to hand them over once (repair-hand-over.ts),
// then dropped from the file.

// Caps stored conclusions; oldest-touched entries drop past this so the file doesn't grow forever.
const CONCLUSIONS_KEPT = 200;

// Announced run ids kept per repo; only needs to outlast RUNS_PER_POLL by a margin.
const ANNOUNCED_KEPT = 60;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });

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
    // Keyed by workspace repo.
    forges: z.record(z.string(), CiForgeSchema).optional(),
    // (2026-11-26) Keyed by the extension's identity (publisher.name): the extensions that took main lines' failures for
    // their own fix agent (main-line-claims.ts), and when.
    mainLineClaims: z.record(z.string(), z.object({ at: z.number() })).optional(),
    // Until 2026-11-26, main's fix agent's own state, as the contract's hand-over carries it (schemas/ci.ts): read once by
    // the hand-over (repair-hand-over.ts), which drops them. Keyed like `conclusions`; only branches failing then.
    failures: z.record(z.string(), CiFailureSchema).optional(),
    // Keyed like `conclusions`: the newest run of each workflow that passed on a main-line branch.
    passes: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    // Keyed by workspace repo: the runs re-run because the CI fleet, not the code, failed them, newest first.
    fleetReruns: z.record(z.string(), z.array(z.number())).optional(),
    // Keyed by fix conversation id: the step outside the repository its latest turn ended on.
    ownerSteps: z.record(z.string(), CiOwnerStepKeptSchema).optional(),
    // (2026-11-26) Who main's repair was handed over to, and when: a later hand-over answers nothing.
    repairHandedOver: z.object({ extension: z.string(), at: z.number() }).optional(),
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
    // The same, with when it was heard.
    readonly conclusion: (repo: string, branch: string) => Promise<{ readonly status: "success" | "failed"; readonly at: number } | undefined>;
    readonly recordConclusion: (repo: string, branch: string, status: "success" | "failed", at: number) => Promise<void>;
    // Ids already announced for this repo, or undefined if never polled: "nothing new" vs "nothing known yet".
    readonly announcedRuns: (repo: string) => Promise<number[] | undefined>;
    // Newest-first; ids past ANNOUNCED_KEPT are forgotten.
    readonly recordAnnounced: (repo: string, runIds: readonly number[]) => Promise<void>;
    // What the forge said of each repository, keyed by workspace repo.
    readonly forges: () => Promise<Readonly<Record<string, CiForge>>>;
    // Merges what the forge said of a repository its remote names `remote`; a fact learned for another remote is
    // replaced, not merged. Writes nothing when it says nothing new, since every delivery says it again.
    readonly learnForge: (repo: string, remote: string, fact: Omit<CiForge, "remote">) => Promise<void>;
    // The identities of the extensions claiming main lines' failures.
    readonly mainLineClaims: () => Promise<readonly string[]>;
    // Records or lets go of one extension's claim.
    readonly claimMainLines: (extension: string, claimed: boolean, at: number) => Promise<void>;
    // Main's repair state as the daemon kept it before 2026-11-26, answered once to `extension` and dropped from the
    // file in the same write; undefined once it was handed over.
    readonly handOverRepair: (extension: string, at: number) => Promise<Omit<CiRepairHandOver, "autoRepair"> | undefined>;
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
        conclusion: async (repo, branch) => (await file.read()).conclusions[keyOf(repo, branch)],
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
        mainLineClaims: async () => Object.keys((await file.read()).mainLineClaims ?? {}),
        claimMainLines: async (extension, claimed, now) => {
            await file.update((state) => {
                const { [extension]: held, ...others } = state.mainLineClaims ?? {};
                if (claimed === (held !== undefined)) {
                    return state;
                }
                return { ...minted(state), mainLineClaims: claimed ? { ...others, [extension]: { at: now } } : others };
            });
        },
        handOverRepair: async (extension, now) => {
            let handed: Omit<CiRepairHandOver, "autoRepair"> | undefined;
            await file.update((state) => {
                const { failures, passes, fleetReruns, ownerSteps, ...rest } = state;
                if (state.repairHandedOver !== undefined) {
                    return state;
                }
                handed = { failures: failures ?? {}, passes: passes ?? {}, fleetReruns: fleetReruns ?? {}, ownerSteps: ownerSteps ?? {} };
                return { ...minted(rest), repairHandedOver: { extension, at: now } };
            });
            return handed;
        },
        recordAnnounced: async (repo, runIds) => {
            await file.update((state) => ({
                ...minted(state),
                announced: { ...state.announced, [repo]: [...new Set(runIds)].slice(0, ANNOUNCED_KEPT) },
            }));
        },
    };
};
