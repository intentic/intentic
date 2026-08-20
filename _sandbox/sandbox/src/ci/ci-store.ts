import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";

// The CI module's daemon-recorded state (<workspace>/.intentic/secrets/ci.json): the per-sandbox webhook secret, the
// last TERMINAL conclusion per repo+branch, what makes a success after a failure read as `pipeline_fixed`, and
// a failure after a success as `pipeline_broken`, across daemon restarts, and the poller's memory of which
// runs it has already announced. It carries a secret, so the file rides the CONTROL_PLANE_ENTRIES denylist
// (workspace-files.ts) like capabilities.json.

// Branches come and go; without pruning a busy workspace's file grows forever. Oldest-touched entries drop
// past this, a branch quiet for that long has no meaningful "was failing" memory anyway.
const CONCLUSIONS_KEPT = 200;

// How many announced run ids are remembered per repo. Only the poller writes these, and only to answer "have
// I already told anyone about this run", a run older than the list window it is checked against can never
// come back, so this only has to outlast RUNS_PER_POLL by a comfortable margin.
const ANNOUNCED_KEPT = 60;

const ConclusionSchema = z.object({ status: z.enum(["success", "failed"]), at: z.number() });
const CiStateSchema = z.object({
    secret: z.string().min(1),
    // Keyed "<repo>\n<branch>" — \n can appear in neither side, so the compound key can't collide.
    conclusions: z.record(z.string(), ConclusionSchema),
    /* Which runs the POLLER has already turned into `ci` events, per workspace repo, its de-duplication, and
     * the thing that makes a restart quiet. Deliberately run ids rather than a timestamp watermark: a run's
     * `createdAt` is when it STARTED, so a long run that finishes after a shorter one started later would fall
     * behind any high-water mark and never be announced at all.
     *
     * An ABSENT entry means "this repo has never been polled", which is what suppresses the backlog storm: the
     * first pass records what it finds and announces none of it. An entry that exists and is empty is a
     * different fact, a repo polled when it had no finished runs, and stays empty rather than re-seeding.
     * Bounded by the workspace's repo count, so it needs no pruning of its own. */
    announced: z.record(z.string(), z.array(z.number())).optional(),
    // When the owner last LOOKED at the pipelines view. Lives here rather than in a browser, on the same
    // reasoning the agents registry records `seenAt` daemon-side: whether a breakage has been seen is a fact
    // about the work, so clearing site data or picking up the phone must not resurrect a badge already dealt
    // with. One timestamp for the whole surface, the view shows every repo at once, so looking at it is one
    // act of reading, not one per run.
    seenAt: z.number().optional(),
});
type CiState = z.infer<typeof CiStateSchema>;

export interface CiStore {
    // The webhook secret, minted on first read and stable after, hook registrations and signature checks
    // must agree across boots.
    readonly secret: () => Promise<string>;
    readonly lastConclusion: (repo: string, branch: string) => Promise<"success" | "failed" | undefined>;
    readonly recordConclusion: (repo: string, branch: string, status: "success" | "failed", at: number) => Promise<void>;
    // The run ids the poller has already announced for this repo, or undefined when it has never polled it,
    // the difference between "nothing new" and "nothing known yet", which is what the poller seeds on.
    readonly announcedRuns: (repo: string) => Promise<number[] | undefined>;
    // Newest-first; older ids past ANNOUNCED_KEPT are forgotten.
    readonly recordAnnounced: (repo: string, runIds: readonly number[]) => Promise<void>;
    // Undefined until the view has been opened once, which reads as "everything is news", the right answer
    // for a surface the owner has never looked at.
    readonly seenAt: () => Promise<number | undefined>;
    readonly markSeen: (at: number) => Promise<void>;
}

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

// Fill the webhook secret if the file had none. Applied inside `update`, so two concurrent first callers can't
// mint two different secrets, hook registrations and the signature check have to agree on one value.
const minted = (state: CiState): CiState => (state.secret === "" ? { ...state, secret: randomBytes(32).toString("hex") } : state);

export const fileCiStore = (path: string): CiStore => {
    const file = jsonFile<CiState>(path, {
        parse: objectParse(CiStateSchema),
        // An EMPTY secret is the in-memory marker for "no file yet", the schema requires a non-empty one, so
        // this shape is never written. `minted` below fills it inside the update queue, which is what stops two
        // concurrent first callers from minting two different secrets; hook registrations and the signature
        // check have to agree on one value across boots.
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
        recordAnnounced: async (repo, runIds) => {
            await file.update((state) => ({
                ...minted(state),
                announced: { ...state.announced, [repo]: [...new Set(runIds)].slice(0, ANNOUNCED_KEPT) },
            }));
        },
        seenAt: async () => (await file.read()).seenAt,
        markSeen: async (at) => {
            await file.update((state) => ({ ...minted(state), seenAt: at }));
        },
    };
};
