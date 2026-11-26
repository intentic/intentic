import type { ExtensionServerApi } from "@intentic/extension-api";
import { type CiFailure, CiFailureSchema, CiOwnerStepKeptSchema, type CiRepairHandOver } from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";

/* MAIN'S REPAIR, AS THIS EXTENSION KEEPS IT (2026-11-26), in `repair.json` under its own state directory: each main-line
   branch failing now with its one fix agent's streak (findings, decisions, turns), the newest run of each workflow that
   passed on a main line, the runs re-run for the CI fleet, and the step outside the repository each fix agent ended on.
   Until 2026-11-26 the daemon kept these in its CI store, beside the webhook secret (ci-store.ts there); the first activation takes
   them over (POST /ci/repair/hand-over), so a sandbox's streaks and their turn counts carry across the update. Besides,
   per repository, the newest run whose news this backend took, from which a gap in its event stream is caught up. */

// Fleet re-runs kept per repo; a run older than these is long past being heard of again.
const FLEET_RERUNS_KEPT = 50;
// Owner steps kept, newest by when they were said; a fix agent older than these has scrolled off the board.
const OWNER_STEPS_KEPT = 50;

const RepairSchema = z.object({
    // Keyed "<repo>\n<branch>": only branches failing right now.
    failures: z.record(z.string(), CiFailureSchema).default({}),
    // Keyed like `failures`: the newest run of each workflow that passed on a main-line branch, so a failure an older run
    // reports afterwards is not taken for main's word.
    passes: z.record(z.string(), z.record(z.string(), z.number())).default({}),
    // Keyed by workspace repo: the runs re-run because the CI fleet, not the code, failed them, newest first.
    fleetReruns: z.record(z.string(), z.array(z.number())).default({}),
    // Keyed by fix conversation id: the step outside the repository its latest turn ended on (owner-steps.ts).
    ownerSteps: z.record(z.string(), CiOwnerStepKeptSchema).default({}),
    // Whether what the daemon kept was taken over (repair.ts takeOver): asked once, whatever it answered.
    handedOver: z.boolean().default(false),
    // Keyed by workspace repo: the newest run id whose news was taken, from the feed or a catch-up.
    caughtUp: z.record(z.string(), z.number()).default({}),
});
type RepairState = z.infer<typeof RepairSchema>;

export interface OwnerStepKept {
    readonly step: string;
    readonly at: number;
}

export interface RepairStore {
    // The main-line branches whose CI fails now, keyed "<repo>\n<branch>".
    readonly failures: () => Promise<Readonly<Record<string, CiFailure>>>;
    // Changes one branch's failure; undefined forgets it. Answers the failure as it now stands.
    readonly failure: (repo: string, branch: string, change: (current: CiFailure | undefined) => CiFailure | undefined) => Promise<CiFailure | undefined>;
    // The newest run of each workflow that passed on the branch.
    readonly passes: (repo: string, branch: string) => Promise<Readonly<Record<string, number>>>;
    // Records a pass, keeping the newest per workflow.
    readonly recordPass: (repo: string, branch: string, workflow: string, runId: number) => Promise<void>;
    // Records a fleet re-run of the run, answering whether it is the first: false means it was re-run before.
    readonly fleetRerun: (repo: string, runId: number) => Promise<boolean>;
    // Whether the run was re-run for the fleet already, without recording anything.
    readonly fleetRerunDone: (repo: string, runId: number) => Promise<boolean>;
    // The step outside the repository each CI fix agent's latest turn ended on, keyed by its conversation id.
    readonly ownerSteps: () => Promise<Readonly<Record<string, OwnerStepKept>>>;
    // Keeps one agent's step, or forgets it with undefined, answering whether anything changed.
    readonly ownerStep: (conversationId: string, kept: OwnerStepKept | undefined) => Promise<boolean>;
    // The newest run whose news was taken for the repository, and recording a newer one.
    readonly caughtUp: (repo: string) => Promise<number | undefined>;
    readonly catchUp: (repo: string, runId: number) => Promise<void>;
    // Takes over what the daemon kept, once: merged under what is here already, which is newer. Answers whether this was
    // the first time.
    readonly takeOver: (handed: () => Promise<CiRepairHandOver>) => Promise<boolean>;
}

const keyOf = (repo: string, branch: string): string => `${repo}\n${branch}`;

export const REPAIR_DOCUMENT = "repair.json";

export const repairStore = (api: Pick<ExtensionServerApi, "document">): RepairStore => {
    const file = api.document<RepairState>(REPAIR_DOCUMENT, {
        parse: (raw) => RepairSchema.safeParse(raw).data,
        fallback: () => RepairSchema.parse({}),
    });
    return {
        failures: async () => (await file.read()).failures,
        failure: async (repo, branch, change) => {
            const key = keyOf(repo, branch);
            const state = await file.update((current) => {
                const next = change(current.failures[key]);
                const { [key]: _previous, ...others } = current.failures;
                return { ...current, failures: next === undefined ? others : { ...others, [key]: next } };
            });
            return state.failures[key];
        },
        passes: async (repo, branch) => (await file.read()).passes[keyOf(repo, branch)] ?? {},
        recordPass: async (repo, branch, workflow, runId) => {
            await file.update((state) => {
                const key = keyOf(repo, branch);
                const known = state.passes[key] ?? {};
                return (known[workflow] ?? 0) >= runId ? state : { ...state, passes: { ...state.passes, [key]: { ...known, [workflow]: runId } } };
            });
        },
        fleetRerunDone: async (repo, runId) => ((await file.read()).fleetReruns[repo] ?? []).includes(runId),
        fleetRerun: async (repo, runId) => {
            let first = false;
            await file.update((state) => {
                const known = state.fleetReruns[repo] ?? [];
                if (known.includes(runId)) {
                    return state;
                }
                first = true;
                return { ...state, fleetReruns: { ...state.fleetReruns, [repo]: [runId, ...known].slice(0, FLEET_RERUNS_KEPT) } };
            });
            return first;
        },
        ownerSteps: async () => (await file.read()).ownerSteps,
        ownerStep: async (conversationId, kept) => {
            let changed = false;
            await file.update((state) => {
                const { [conversationId]: previous, ...others } = state.ownerSteps;
                if (kept === undefined ? previous === undefined : previous?.step === kept.step) {
                    return state;
                }
                changed = true;
                const steps = kept === undefined ? others : { ...others, [conversationId]: kept };
                const newest = Object.entries(steps)
                    .toSorted(([, a], [, b]) => b.at - a.at)
                    .slice(0, OWNER_STEPS_KEPT);
                return { ...state, ownerSteps: Object.fromEntries(newest) };
            });
            return changed;
        },
        caughtUp: async (repo) => (await file.read()).caughtUp[repo],
        catchUp: async (repo, runId) => {
            await file.update((state) => ((state.caughtUp[repo] ?? 0) >= runId ? state : { ...state, caughtUp: { ...state.caughtUp, [repo]: runId } }));
        },
        takeOver: async (handed) => {
            if ((await file.read()).handedOver) {
                return false;
            }
            const taken = await handed();
            let first = false;
            await file.update((state) => {
                if (state.handedOver) {
                    return state;
                }
                first = true;
                return {
                    ...state,
                    failures: { ...taken.failures, ...state.failures },
                    passes: { ...taken.passes, ...state.passes },
                    fleetReruns: { ...taken.fleetReruns, ...state.fleetReruns },
                    ownerSteps: { ...taken.ownerSteps, ...state.ownerSteps },
                    handedOver: true,
                };
            });
            return first;
        },
    };
};
